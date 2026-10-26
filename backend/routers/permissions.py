import uuid
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import ARRAY, Text, bindparam, select, exc, or_, false
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from auth import has_admin_role, verify_admin_or_operator_request, verify_admin_request
from terminal_assignments import browser_identity, require_checkpoint
from database import get_db, get_read_db
from data_limits import bounded_rows, precharge_mutation_response
from event_outbox import enqueue_presence, enqueue_workflow_start, enqueue_workflow_signal
from models import (
    Subject, PermissionRequestModel, Checkpoint,
    AccessPermission, Person, HardwareAsset, AuditEvent,
)
from schemas import PermissionRequestCreate, PermissionGrantCreate, PermissionDecision
from permission_decisions import (review_source, require_recent_review_source, pending_manual_review,
                                  enqueue_decision, permission_version, zone_permission_version,
                                  custody_version, has_unexpired_permission)
from access_validation import (validate_window, validate_permission_window, validate_zones,
    require_registered_checkpoint, validate_registered_zones)
from facility_zones import CHECKPOINT_IDS
from subject_metadata import current_subject_metadata
from registry_validation import is_barcode_conflict
from zone_access import (admin_zone_ids, require_checkpoint_scope,
    require_subject_scope, subject_zone_condition, validate_zone_subset)

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
    allowed_zones = await admin_zone_ids(db, admin)
    checkpoint_id = await require_registered_checkpoint(db, payload.checkpoint_id)
    await require_checkpoint_scope(db, admin, checkpoint_id)
    if payload.subject_id:
        await require_subject_scope(db, admin, payload.subject_id)
    if payload.request_type == "hardware_custody" and payload.carrier_id:
        await require_subject_scope(db, admin, payload.carrier_id)
    if payload.requested_zones:
        requested_zones = await validate_registered_zones(db, payload.requested_zones)
        validate_zone_subset(requested_zones, allowed_zones)
    try:
        result, signal_visitor = await apply_direct_permission(db, payload, admin.get("sub", "unknown"),
            known_zone_ids=allowed_zones)
        await _include_entry_restrictions(db, result)
        if signal_visitor:
            await enqueue_workflow_signal(db, f"visitor-{result['request']['id']}", ["approved", payload.reason])
        await enqueue_decision(db, result)
        await precharge_mutation_response(db, result)
        await db.commit()
    except HTTPException:
        await db.rollback()
        raise
    except exc.IntegrityError as error:
        await db.rollback()
        if is_barcode_conflict(error):
            raise HTTPException(409, "This barcode is already registered")
        raise
    except exc.DBAPIError as error:
        await db.rollback()
        if getattr(error.orig, "sqlstate", None) == "55P03":
            raise HTTPException(409, "This permission is being decided by another administrator. Retry after that decision.")
        raise
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
    checkpoint_id = await require_registered_checkpoint(db, payload.checkpoint_id)
    if not has_admin_role(actor):
        checkpoint_id = await require_checkpoint(db, browser_identity(actor), checkpoint_id)
    else:
        await require_checkpoint_scope(db, actor, checkpoint_id)
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
            await precharge_mutation_response(db, existing.data)
            return existing.data
        visitor_permission = await db.scalar(select(AccessPermission).where(
            AccessPermission.subject_id == subject.id).execution_options(populate_existing=True))
        if has_unexpired_permission(visitor_permission):
            raise HTTPException(409, "This visitor already has an active permission. An administrator can change its access.")

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
    checkpoint_zone = checkpoint.zone_id
    if has_admin_role(actor):
        await require_subject_scope(db, actor, subject.id)
    else:
        visible_subject = await db.scalar(select(Subject.id).outerjoin(Person, Person.subject_id == Subject.id)
            .outerjoin(HardwareAsset, HardwareAsset.subject_id == Subject.id)
            .outerjoin(AccessPermission, AccessPermission.subject_id == Subject.id)
            .where(Subject.id == subject.id, subject_zone_condition([checkpoint.zone_id])))
        if visible_subject is None:
            raise HTTPException(404, "Subject not found")
    valid_from = payload.valid_from or now.isoformat()
    valid_to = payload.valid_to or (now + timedelta(hours=1)).isoformat()
    if payload.request_type == "zone_access" and not payload.requested_zones:
        raise HTTPException(422, "Choose the complete requested zone set")
    requested_zones = payload.requested_zones or [checkpoint_zone]
    if has_admin_role(actor) and payload.request_type != "hardware_custody":
        actor_zones = await admin_zone_ids(db, actor)
        requested_zones = await validate_registered_zones(db, requested_zones)
        validate_zone_subset(requested_zones, actor_zones)
        if payload.request_type == "visitor" and requested_zones != [checkpoint.zone_id]:
            raise HTTPException(422, "Visitor access must use the selected checkpoint's zone")
        if payload.request_type == "zone_access" and any(zone not in actor_zones for zone in requested_zones):
            raise HTTPException(403, "Requested zone is outside your assigned scope")
    elif payload.request_type != "hardware_custody":
        requested_zones = validate_zones(requested_zones, known_zone_ids=[checkpoint.zone_id])
    if payload.request_type == "hardware_custody":
        carrier = await db.get(Subject, payload.carrier_id) if payload.carrier_id else None
        if not carrier or carrier.kind != "employee":
            raise HTTPException(422, "Custody approval requires a registered employee")
        if has_admin_role(actor):
            await require_subject_scope(db, actor, carrier.id)
        else:
            visible_carrier = await db.scalar(select(Subject.id).outerjoin(Person, Person.subject_id == Subject.id)
                .where(Subject.id == carrier.id, subject_zone_condition([checkpoint.zone_id])))
            if visible_carrier is None:
                raise HTTPException(404, "Employee not found")
        if (subject_data.get("assignedEmployeeId") or subject_data.get("ownerId")) == carrier.id:
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
        if not payload.event_id:
            raise HTTPException(status_code=422, detail="Manual review requires its denied scan event")
        source = await review_source(db, payload.event_id, subject.barcode, checkpoint.id, direction)
        require_recent_review_source(source, now=now)
        if source.subject_id != subject.id:
            raise HTTPException(status_code=422, detail="Manual review scan belongs to a different subject")
        direction = direction or (source.direction if source else None) or ("exit" if checkpoint.data.get("mode") == "exit" else "entry")
        existing = await pending_manual_review(db, subject.barcode, checkpoint.id, direction)
        if existing:
            await precharge_mutation_response(db, existing.data)
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
    if payload.request_type == "visitor":
        data["permissionVersion"] = permission_version(visitor_permission)
    if payload.carrier_id:
        data["carrierId"] = payload.carrier_id
    if payload.carrier_name:
        data["carrierName"] = payload.carrier_name
    if payload.request_type == "hardware_custody":
        data.update(hardwareId=subject.id, carrierId=carrier.id,
            custodyVersion=custody_version(subject_data),
            carrierName=carrier_metadata.data.get("name", carrier.barcode) if carrier_metadata else carrier.barcode,
            previousCarrierId=subject_data.get("assignedEmployeeId") or subject_data.get("ownerId") or "",
            previousCarrierName=subject_data.get("assignedEmployeeName") or "Unassigned")
    if payload.request_type == "zone_access":
        permission = await db.scalar(select(AccessPermission).where(AccessPermission.subject_id == subject.id).order_by(AccessPermission.id).limit(1))
        previous = permission.data if permission else subject_data
        data["permissionVersion"] = zone_permission_version(permission, subject_data)
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
    if payload.request_type in {"manual_override", "visitor"}:
        await enqueue_workflow_start(db, req_id, visitor=payload.request_type == "visitor")
    await enqueue_decision(db, {"request": data})
    await precharge_mutation_response(db, data)
    await db.commit()

    return data

@router.post("/v1/permission-requests/{req_id}/decide")
async def decide_permission_request(
    req_id: str,
    payload: PermissionDecision,
    db: AsyncSession = Depends(get_db),
    admin: dict = Depends(verify_admin_request)
):
    from permission_decisions import apply_permission_decision

    existing_request = await db.scalar(select(PermissionRequestModel).where(
        PermissionRequestModel.id == req_id).with_for_update())
    if existing_request is None:
        raise HTTPException(404, "Request not found")
    request_data = existing_request.data or {}
    checkpoint_id = request_data.get("checkpointId")
    if isinstance(checkpoint_id, str) and checkpoint_id:
        await require_checkpoint_scope(db, admin, checkpoint_id)
    else:
        requested_zones = await validate_registered_zones(db, request_data.get("requestedZones") or [])
        validate_zone_subset(requested_zones, await admin_zone_ids(db, admin))

    reason = (payload.reason or "").strip()
    if payload.decision == "denied" and not reason:
        raise HTTPException(status_code=422, detail="A decision note is required when denying a permission request")
    # The row lock, decision, identity, movement and presence share one transaction.
    result = await apply_permission_decision(
        db, req_id, payload.decision, admin.get("sub", "unknown"),
        reason or "Permission approved.", valid_for_minutes=payload.valid_for_minutes,
    )
    await _include_entry_restrictions(db, result)
    req_type = result["request"].get("type")
    workflow_queued = False
    if req_type in {"manual_override", "visitor"}:
        prefix = "override" if req_type == "manual_override" else "visitor"
        effective_decision = result["request"].get("status", payload.decision)
        effective_actor = result["request"].get("decidedBy") or admin.get("sub", "unknown")
        effective_reason = result["request"].get("decisionReason") or reason or "Permission approved."
        args = ([effective_decision, effective_actor, effective_reason]
                if req_type == "manual_override" else [effective_decision, effective_reason])
        await enqueue_workflow_signal(db, f"{prefix}-{req_id}", args)
        workflow_queued = True
    await enqueue_decision(db, result)
    response = {**result, "workflowSignaled": False, "workflowQueued": workflow_queued}
    await precharge_mutation_response(db, response)
    await db.commit()
    return response


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
        await require_checkpoint(db, browser_identity(actor), data.get("checkpointId"))
    else:
        await require_checkpoint_scope(db, actor, data.get("checkpointId"))
    if data.get("type") != "manual_override":
        raise HTTPException(status_code=422, detail="Only manual-review notifications can be dismissed")
    if data.get("status") not in {"approved", "denied"}:
        raise HTTPException(status_code=409, detail="Awaiting a permission decision")
    if data.get("notificationDismissedAt"):
        await precharge_mutation_response(db, data)
        return data

    data = {
        **data,
        "notificationDismissedAt": datetime.now(timezone.utc).isoformat(),
        "notificationDismissedBy": actor.get("sub") or "Terminal Operator",
    }
    req.data = data
    await enqueue_presence(db, {"type": "terminal_notification_dismissed", "requestId": req_id, "request": data})
    await precharge_mutation_response(db, data)
    await db.commit()
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
    from event_outbox import read_event_revision
    event_revision = await read_event_revision(db)
    zone_ids = await admin_zone_ids(db, _admin)
    visible_subject_rows = await bounded_rows(db,
        select(Subject.id).outerjoin(Person, Person.subject_id == Subject.id)
        .outerjoin(HardwareAsset, HardwareAsset.subject_id == Subject.id)
        .outerjoin(AccessPermission, AccessPermission.subject_id == Subject.id)
        .where(subject_zone_condition(zone_ids)).distinct().order_by(Subject.id)
    )
    visible_subject_ids = [row[0] for row in visible_subject_rows]

    async def fetch_permissions():
        requests = await fetch_requests()
        request_managed_subject_ids: set[str] = set()
        for request in requests:
            subject_id = request.get("subjectId") or request.get("subject_id")
            approved_access = request.get("status") == "approved" and request.get("type") in {"visitor", "zone_access"}
            if subject_id and approved_access:
                request_managed_subject_ids.add(str(subject_id))
        manual_audit_rows = await bounded_rows(db,
            select(AuditEvent.data["subjectId"].astext).distinct().where(
                AuditEvent.data["category"].astext == "permission",
                AuditEvent.data["action"].astext.in_((
                    "Manual permission granted",
                    "Manual permission changed",
                )),
                or_(AuditEvent.data["zoneId"].astext.in_(zone_ids),
                    AuditEvent.data["checkpointId"].astext.in_(select(Checkpoint.id).where(Checkpoint.zone_id.in_(zone_ids))),
                    AuditEvent.data["subjectId"].astext.in_(visible_subject_ids) if visible_subject_ids else false()),
            )
        )
        manually_managed_subject_ids = {
            str(row[0]) for row in manual_audit_rows if row[0]
        }
        permission_rows = await bounded_rows(db,
            select(AccessPermission, Subject.kind, Subject.barcode)
            .join(Subject, AccessPermission.subject_id == Subject.id)
            .where(Subject.id.in_(visible_subject_ids))
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
        for permission, subject_kind, subject_barcode in permission_rows:
            if subject_kind not in {"employee", "visitor", "hardware"}:
                continue
            data = dict(permission.data or {})
            if permission.subject_id in seen_subject_ids:
                continue
            seen_subject_ids.add(permission.subject_id)
            data.setdefault("id", permission.id)
            data.setdefault("subjectId", permission.subject_id)
            data["barcode"] = subject_barcode
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
        requested_zone_ids = bindparam("requested_zone_ids", value=list(zone_ids), type_=ARRAY(Text()))
        rows = await bounded_rows(db, select(PermissionRequestModel).where(or_(
            PermissionRequestModel.data["requestedZones"].has_any(requested_zone_ids),
            PermissionRequestModel.data["checkpointId"].astext.in_(select(Checkpoint.id).where(Checkpoint.zone_id.in_(zone_ids))),
            PermissionRequestModel.subject_id.in_(visible_subject_ids) if visible_subject_ids else false(),
        )).order_by(PermissionRequestModel.created_at.desc()))
        return [row[0].data for row in rows]

    people, hardware, requests = await fetch_permissions()
    registered_subjects = [row[0] for row in await bounded_rows(db,
        select(Subject).outerjoin(Person, Person.subject_id == Subject.id)
        .outerjoin(HardwareAsset, HardwareAsset.subject_id == Subject.id)
        .outerjoin(AccessPermission, AccessPermission.subject_id == Subject.id)
        .where(subject_zone_condition(zone_ids))
        .options(selectinload(Subject.person), selectinload(Subject.hardware)).order_by(Subject.id))]
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
    checkpoint_result = await db.execute(select(Checkpoint).where(
        Checkpoint.id.in_(CHECKPOINT_IDS), Checkpoint.zone_id.in_(zone_ids)).order_by(Checkpoint.zone_id, Checkpoint.id))
    checkpoints = [{**(checkpoint.data or {}), "id": checkpoint.id} for checkpoint in checkpoint_result.scalars().all()]

    return {
        "eventRevision": event_revision,
        "people":         people,
        "hardware":       hardware,
        "requests":       requests,
        "subjects":       subjects,
        "checkpoints":    checkpoints,
    }
