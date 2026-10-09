import uuid
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, exc
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from auth import has_admin_role, verify_admin_or_operator_request, verify_admin_request
from terminal_assignments import browser_identity, require_checkpoint
from database import get_db, get_read_db
from models import (
    Subject, PermissionRequestModel, Checkpoint,
    AccessPermission, Person, HardwareAsset, AuditEvent,
)
from schemas import PermissionRequestCreate, PermissionGrantCreate, PermissionDecision
from temporal_worker import get_temporal_client, TASK_QUEUE
from workflows.permission_override import PermissionOverrideWorkflow
from workflows.visitor_approval import VisitorApprovalWorkflow
from permission_decisions import review_source, pending_manual_review, publish_decision
from access_validation import validate_window, validate_permission_window, validate_zones, validate_checkpoint_id
from facility_zones import CHECKPOINT_IDS
from redis_client import publish_presence_update
from subject_metadata import current_subject_metadata
import json

logger = logging.getLogger(__name__)

router = APIRouter(tags=["permissions"])


async def _include_entry_restrictions(db, result):
    from critical_entry_restrictions import entry_restrictions_for_subjects
    records = [result.get(key) for key in ("permission", "person", "hardwareAsset")]
    records += result.get("hardwareAssets") or []
    subject_ids = [record.get("subjectId") or record.get("id") for record in records if record]
    restriction_map = await entry_restrictions_for_subjects(db, subject_ids)
    for key in ("permission", "person", "hardwareAsset"):
        record = result.get(key)
        if record:
            result[key] = {**record, "entryRestriction": restriction_map.get(record.get("subjectId") or record.get("id"))}
    if result.get("hardwareAssets"):
        result["hardwareAssets"] = [{**record, "entryRestriction": restriction_map.get(record.get("subjectId") or record.get("id"))}
            for record in result["hardwareAssets"]]
    return result


@router.post("/v1/permissions/grant", status_code=201)
async def grant_permission(
    payload: PermissionGrantCreate,
    db: AsyncSession = Depends(get_db),
    admin: dict = Depends(verify_admin_request),
):
    from permission_grants import apply_direct_permission
    try:
        result, signal_visitor = await apply_direct_permission(db, payload, admin.get("sub", "unknown"))
        await db.commit()
    except exc.IntegrityError as error:
        await db.rollback()
        from routers.registry import _is_barcode_conflict
        if _is_barcode_conflict(error):
            raise HTTPException(409, "This barcode is already registered")
        raise
    except exc.DBAPIError as error:
        await db.rollback()
        if getattr(error.orig, "sqlstate", None) == "55P03":
            raise HTTPException(409, "This permission is being decided by another administrator. Retry after that decision.")
        raise
    await _include_entry_restrictions(db, result)
    await publish_decision(result)
    if signal_visitor:
        try:
            client = await get_temporal_client()
            await client.get_workflow_handle(f"visitor-{result['request']['id']}").signal(
                "admin_decision", args=["approved", payload.reason])
        except Exception:
            logger.exception("Direct permission committed; visitor workflow signal unavailable")
    return result


# ===========================================================================
# ORIGINAL endpoints (prefix: /v1/permission-requests)
# ===========================================================================

@router.post("/v1/permission-requests")
async def create_permission_request(
    payload: PermissionRequestCreate,
    db: AsyncSession = Depends(get_db),
    actor: dict = Depends(verify_admin_or_operator_request),
):
    checkpoint_id = validate_checkpoint_id(payload.checkpoint_id)
    if not has_admin_role(actor):
        checkpoint_id = await require_checkpoint(db, browser_identity(actor), checkpoint_id)
    stmt = select(Subject).where(Subject.id == payload.subject_id).with_for_update()
    subject = (await db.execute(stmt)).scalar_one_or_none()
    if not subject:
        raise HTTPException(status_code=404, detail="Subject not found")
    if payload.request_type == "visitor" and subject.kind != "visitor":
        raise HTTPException(422, "Visitor approval requires a visitor")
    if payload.request_type == "hardware_custody" and (subject.kind != "hardware" or payload.hardware_id not in (None, subject.id)):
        raise HTTPException(422, "Custody review subject must be the requested hardware")
    if payload.request_type == "visitor":
        existing = await db.scalar(select(PermissionRequestModel).where(
            PermissionRequestModel.subject_id == subject.id,
            PermissionRequestModel.data["type"].astext == "visitor",
            PermissionRequestModel.data["status"].astext == "pending",
        ).order_by(PermissionRequestModel.created_at).limit(1))
        if existing:
            return existing.data

    now = datetime.now(timezone.utc)
    req_id = f"REQ-{uuid.uuid4().hex[:8].upper()}"

    subject_data: dict[str, Any] = {}
    if subject.kind in ("employee", "visitor"):
        person_result = await db.execute(select(Person).where(Person.subject_id == subject.id))
        person = person_result.scalar_one_or_none()
        subject_data = dict(person.data or {}) if person else {}
    elif subject.kind == "hardware":
        hardware_result = await db.execute(select(HardwareAsset).where(HardwareAsset.subject_id == subject.id))
        hardware = hardware_result.scalar_one_or_none()
        subject_data = dict(hardware.data or {}) if hardware else {}

    checkpoint = await db.get(Checkpoint, checkpoint_id)
    if not checkpoint:
        raise HTTPException(status_code=422, detail="Checkpoint not registered")
    checkpoint_name = checkpoint.data.get("name", checkpoint.id)
    checkpoint_zone = checkpoint.data.get("zone", checkpoint_name)
    valid_from = payload.valid_from or now.isoformat()
    valid_to = payload.valid_to or (now + timedelta(hours=1)).isoformat()
    if payload.request_type == "zone_access" and not payload.requested_zones:
        raise HTTPException(422, "Choose the complete requested zone set")
    requested_zones = payload.requested_zones or [checkpoint_zone]
    requested_zones = validate_zones(requested_zones)
    if payload.request_type == "hardware_custody":
        carrier = await db.get(Subject, payload.carrier_id) if payload.carrier_id else None
        if not carrier or carrier.kind != "employee":
            raise HTTPException(422, "Custody approval requires a registered employee")
        if subject_data.get("assignedEmployeeId") == carrier.id:
            raise HTTPException(422, "This employee already has custody of this asset")
        pending_custody = await db.scalar(select(PermissionRequestModel).where(
            PermissionRequestModel.subject_id == subject.id,
            PermissionRequestModel.data["type"].astext == "hardware_custody",
            PermissionRequestModel.data["status"].astext == "pending",
            PermissionRequestModel.data["carrierId"].astext == carrier.id,
        ).order_by(PermissionRequestModel.created_at).limit(1))
        if pending_custody:
            raise HTTPException(409, "This employee already has a pending custody request for this asset")
        carrier_metadata = await db.get(Person, carrier.id)
        valid_from, valid_to, requested_zones = "", "", []
    else:
        if payload.request_type in {"visitor", "zone_access"}:
            validate_permission_window(valid_from, valid_to, now=now)
        else:
            validate_window(valid_from, valid_to)
    direction = payload.direction
    if payload.request_type == "manual_override":
        if not payload.operator_note or not payload.operator_note.strip():
            raise HTTPException(status_code=422, detail="A note is required for a manual permission request")
        source = await review_source(db, payload.event_id, subject.barcode, checkpoint.id, direction)
        direction = direction or (source.direction if source else None) or ("exit" if checkpoint.data.get("mode") == "exit" else "entry")
        existing = await pending_manual_review(db, subject.barcode, checkpoint.id, direction)
        if existing:
            return existing.data

    data = {
        "id": req_id,
        "subjectId": subject.id,
        "subjectName": subject_data.get("name") or subject.barcode,
        "subjectType": subject.kind,
        "barcode": subject.barcode,
        "type": payload.request_type,
        "purpose": payload.reason.strip(),
        "checkpointId": checkpoint.id,
        "checkpoint": checkpoint_name,
        "requester": actor.get("sub") or "Terminal Operator",
        "requestedZones": requested_zones,
        "validFrom": valid_from,
        "validTo": valid_to,
        "status": "pending",
        "createdAt": now.isoformat()
    }
    if payload.hardware_id:
        data["hardwareId"] = payload.hardware_id
    if payload.carrier_id:
        data["carrierId"] = payload.carrier_id
    if payload.carrier_name:
        data["carrierName"] = payload.carrier_name
    if payload.request_type == "hardware_custody":
        data.update(hardwareId=subject.id, carrierId=carrier.id,
            carrierName=carrier_metadata.data.get("name", carrier.barcode) if carrier_metadata else carrier.barcode,
            previousCarrierId=subject_data.get("assignedEmployeeId") or "",
            previousCarrierName=subject_data.get("assignedEmployeeName") or "Unassigned")
    if payload.request_type == "zone_access":
        permission = await db.scalar(select(AccessPermission).where(AccessPermission.subject_id == subject.id).order_by(AccessPermission.id).limit(1))
        previous = permission.data if permission else subject_data
        data.update(previousZones=previous.get("zones") or previous.get("allowedZones") or [],
            previousValidFrom=previous.get("validFrom") or "", previousValidTo=previous.get("validTo") or "")
    if payload.event_id:
        data["eventId"] = payload.event_id
    if direction:
        data["direction"] = direction
    if payload.operator_note:
        data["operatorNote"] = payload.operator_note.strip()

    req_model = PermissionRequestModel(
        id=req_id,
        subject_id=subject.id,
        data=data,
        created_at=now
    )
    db.add(req_model)
    await db.commit()
    await publish_decision({"request": data})

    if payload.request_type == "manual_override":
        try:
            client = await get_temporal_client()
            await client.start_workflow(
                PermissionOverrideWorkflow.run,
                args=[req_id],
                id=f"override-{req_id}",
                task_queue=TASK_QUEUE,
            )
        except Exception as e:
            logger.exception("Failed to start PermissionOverrideWorkflow")
    elif payload.request_type == "visitor":
        try:
            client = await get_temporal_client()
            await client.start_workflow(
                VisitorApprovalWorkflow.run,
                args=[req_id],
                id=f"visitor-{req_id}",
                task_queue=TASK_QUEUE,
            )
        except Exception:
            logger.exception("Failed to start VisitorApprovalWorkflow")

    return data

@router.post("/v1/permission-requests/{req_id}/decide")
async def decide_permission_request(
    req_id: str,
    payload: PermissionDecision,
    db: AsyncSession = Depends(get_db),
    admin: dict = Depends(verify_admin_request)
):
    from permission_decisions import apply_permission_decision, publish_decision

    reason = (payload.reason or "").strip()
    if payload.decision == "denied" and not reason:
        raise HTTPException(status_code=422, detail="A decision note is required when denying a permission request")
    # The row lock, decision, identity, movement and presence share one transaction.
    result = await apply_permission_decision(
        db, req_id, payload.decision, admin.get("sub", "unknown"),
        reason or "Permission approved.", valid_for_minutes=payload.valid_for_minutes,
    )
    await db.commit()
    await _include_entry_restrictions(db, result)
    await publish_decision(result)
    req_type = result["request"].get("type")
    workflow_signaled = False
    if req_type in {"manual_override", "visitor"}:
        try:
            client = await get_temporal_client()
            prefix = "override" if req_type == "manual_override" else "visitor"
            args = ([payload.decision, admin.get("sub", "unknown"), reason or "Permission approved."]
                    if req_type == "manual_override" else [payload.decision, reason or "Permission approved."])
            await client.get_workflow_handle(f"{prefix}-{req_id}").signal("admin_decision", args=args)
            workflow_signaled = True
        except Exception:
            logger.exception("Decision committed; workflow signal unavailable")
    return {**result, "workflowSignaled": workflow_signaled}


@router.post("/v1/permission-requests/{req_id}/dismiss")
async def dismiss_permission_notification(
    req_id: str,
    db: AsyncSession = Depends(get_db),
    actor: dict = Depends(verify_admin_or_operator_request),
):
    """Hide a completed decision notice without changing the decision/history."""
    req = await db.scalar(
        select(PermissionRequestModel)
        .where(PermissionRequestModel.id == req_id)
        .with_for_update()
    )
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")

    data = dict(req.data or {})
    if not has_admin_role(actor):
        await require_checkpoint(db, browser_identity(actor), validate_checkpoint_id(data.get("checkpointId")))
    if data.get("type") != "manual_override":
        raise HTTPException(status_code=422, detail="Only manual-review notifications can be dismissed")
    if data.get("status") not in {"approved", "denied"}:
        raise HTTPException(status_code=409, detail="Awaiting a permission decision")
    if data.get("notificationDismissedAt"):
        return data

    data = {
        **data,
        "notificationDismissedAt": datetime.now(timezone.utc).isoformat(),
        "notificationDismissedBy": actor.get("sub") or "Terminal Operator",
    }
    req.data = data
    await db.commit()
    try:
        await publish_presence_update(json.dumps({
            "type": "terminal_notification_dismissed", "requestId": req_id, "request": data,
        }))
    except Exception:
        logger.exception("Notification dismissed; live publication failed")
    return data


# ===========================================================================
# NEW endpoints
# ===========================================================================

# ---------------------------------------------------------------------------
# GET /v1/permissions  — consolidated read (admin-only)
# ---------------------------------------------------------------------------

@router.get("/v1/permissions")
async def list_permissions(
    db: AsyncSession = Depends(get_read_db),
    _admin: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    """
    Return a consolidated snapshot:
    - people:      all registered employee/visitor access
    - hardware:    all registered hardware access
    - requests:    PermissionRequestModel.data[]
    - subjects:    registered subjects available for future assignments
    Reads run on one scoped session so they observe a coherent snapshot.
    """
    async def fetch_permissions():
        requests = await fetch_requests()
        request_managed_subject_ids: set[str] = set()
        for request in requests:
            subject_id = request.get("subjectId") or request.get("subject_id")
            approved_access = request.get("status") == "approved" and request.get("type") in {"visitor", "zone_access"}
            if subject_id and approved_access:
                request_managed_subject_ids.add(str(subject_id))
        manual_audit_result = await db.execute(
            select(AuditEvent.data["subjectId"].astext).distinct().where(
                AuditEvent.data["category"].astext == "permission",
                AuditEvent.data["action"].astext.in_((
                    "Manual permission granted",
                    "Manual permission changed",
                )),
            )
        )
        manually_managed_subject_ids = {
            str(subject_id)
            for subject_id in manual_audit_result.scalars().all()
            if subject_id
        }
        res = await db.execute(
            select(AccessPermission, Subject.kind)
            .join(Subject, AccessPermission.subject_id == Subject.id)
            .order_by(
                Subject.kind,
                Subject.id,
                AccessPermission.data["updatedAt"].astext.desc().nullslast(),
                AccessPermission.id,
            )
        )
        people: list[dict[str, Any]] = []
        hardware: list[dict[str, Any]] = []
        seen_subject_ids: set[str] = set()
        for permission, subject_kind in res.all():
            if subject_kind not in {"employee", "visitor", "hardware"}:
                continue
            data = dict(permission.data or {})
            if permission.subject_id in seen_subject_ids:
                continue
            seen_subject_ids.add(permission.subject_id)
            data.setdefault("id", permission.id)
            data.setdefault("subjectId", permission.subject_id)
            if data.get("source") == "manual" or permission.subject_id in manually_managed_subject_ids:
                data["source"] = "manual"
            elif permission.subject_id in request_managed_subject_ids:
                data["source"] = "request"
            # The relational subject kind is authoritative. In particular,
            # manually approved visitors belong in the People directory.
            data["subjectType"] = subject_kind
            (hardware if subject_kind == "hardware" else people).append(data)
        return people, hardware, requests

    async def fetch_requests():
        res = await db.execute(select(PermissionRequestModel).order_by(PermissionRequestModel.created_at.desc()))
        return [r.data for r in res.scalars().all()]

    people, hardware, requests = await fetch_permissions()
    subject_result = await db.execute(select(Subject).options(selectinload(Subject.person), selectinload(Subject.hardware)).order_by(Subject.id))
    registered_subjects = subject_result.scalars().all()
    from critical_entry_restrictions import entry_restrictions_for_subjects
    restriction_map = await entry_restrictions_for_subjects(db, [subject.id for subject in registered_subjects])
    for permission in people + hardware:
        permission["entryRestriction"] = restriction_map.get(permission["subjectId"])
    directory_ids = {permission["subjectId"] for permission in people + hardware}
    subjects = []
    for subject in registered_subjects:
        metadata = subject.hardware if subject.kind == "hardware" else subject.person
        if metadata:
            subjects.append({**current_subject_metadata(subject.kind, metadata.data), "id": subject.id, "barcode": subject.barcode, "type": subject.kind,
                "entryRestriction": restriction_map.get(subject.id)})
            if subject.id not in directory_ids:
                data = metadata.data or {}
                state = {"pre_approved": "active", "inactive": "revoked", "maintenance": "restricted"}.get(data.get("status"), data.get("status", "active"))
                record = {"id": f"subject-{subject.id}", "subjectId": subject.id,
                    "subjectName": data.get("name") or subject.barcode, "subjectType": subject.kind,
                    "assignment": subject.kind.title(), "state": state,
                    "zones": data.get("allowedZones") or [], "validFrom": data.get("validFrom") or "",
                    "validTo": data.get("validTo") or "", "source": "policy",
                    "updatedAt": data.get("createdAt") or "", "updatedBy": "system",
                    "entryRestriction": restriction_map.get(subject.id)}
                (hardware if subject.kind == "hardware" else people).append(record)
    checkpoint_result = await db.execute(select(Checkpoint).where(Checkpoint.id.in_(CHECKPOINT_IDS)).order_by(Checkpoint.id))
    checkpoints = [{**checkpoint.data, "id": checkpoint.id} for checkpoint in checkpoint_result.scalars().all()]

    return {
        "people":         people,
        "hardware":       hardware,
        "requests":       requests,
        "subjects":       subjects,
        "checkpoints":    checkpoints,
    }
