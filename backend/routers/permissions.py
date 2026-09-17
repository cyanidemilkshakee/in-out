import uuid
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Body
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from auth import verify_admin_or_operator_request, verify_admin_request
from database import get_db, get_read_db
from models import (
    Subject, PermissionRequestModel, Movement, Checkpoint,
    AccessPermission, Person, HardwareAsset, AuditEvent, Notification,
)
from schemas import PermissionRequestCreate, PermissionDecision
from temporal_worker import get_temporal_client, TASK_QUEUE
from workflows.permission_override import PermissionOverrideWorkflow
from workflows.visitor_approval import VisitorApprovalWorkflow
from permission_decisions import review_source, pending_manual_review, publish_decision
from access_validation import validate_window, validate_zones

logger = logging.getLogger(__name__)

router = APIRouter(tags=["permissions"])


# ===========================================================================
# ORIGINAL endpoints (prefix: /v1/permission-requests)
# ===========================================================================

@router.post("/v1/permission-requests")
async def create_permission_request(
    payload: PermissionRequestCreate,
    db: AsyncSession = Depends(get_db),
    actor: dict = Depends(verify_admin_or_operator_request),
):
    stmt = select(Subject).where(Subject.id == payload.subject_id)
    subject = (await db.execute(stmt)).scalar_one_or_none()
    if not subject:
        raise HTTPException(status_code=404, detail="Subject not found")
    if payload.request_type == "visitor" and subject.kind != "visitor":
        raise HTTPException(422, "Visitor approval requires a visitor")
    if payload.request_type == "hardware_custody" and (subject.kind != "hardware" or payload.hardware_id not in (None, subject.id)):
        raise HTTPException(422, "Custody review subject must be the requested hardware")

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

    checkpoint = await db.get(Checkpoint, payload.checkpoint_id)
    if not checkpoint:
        raise HTTPException(status_code=422, detail="Checkpoint not registered")
    checkpoint_name = checkpoint.data.get("name", checkpoint.id)
    checkpoint_zone = checkpoint.data.get("zone", checkpoint_name)
    valid_from = payload.valid_from or now.isoformat()
    valid_to = payload.valid_to or (now + timedelta(hours=1)).isoformat()
    requested_zones = payload.requested_zones or [checkpoint_zone]
    requested_zones = validate_zones(requested_zones)
    validate_window(valid_from, valid_to)
    direction = payload.direction
    if payload.request_type == "manual_override":
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
        "purpose": payload.reason,
        "checkpointId": payload.checkpoint_id,
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
    if payload.event_id:
        data["eventId"] = payload.event_id
    if direction:
        data["direction"] = direction

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

    # The row lock, decision, identity, movement and presence share one transaction.
    result = await apply_permission_decision(
        db, req_id, payload.decision, admin.get("sub", "unknown"),
        payload.reason or f"{payload.decision.title()} by Permission Manager after policy review",
    )
    await db.commit()
    await publish_decision(result)
    req_type = result["request"].get("type")
    workflow_signaled = False
    if req_type in {"manual_override", "visitor"}:
        try:
            client = await get_temporal_client()
            prefix = "override" if req_type == "manual_override" else "visitor"
            args = ([payload.decision, admin.get("sub", "unknown"), payload.reason or ""]
                    if req_type == "manual_override" else [payload.decision, payload.reason or ""])
            await client.get_workflow_handle(f"{prefix}-{req_id}").signal("admin_decision", args=args)
            workflow_signaled = True
        except Exception:
            logger.exception("Decision committed; workflow signal unavailable")
    return {**result, "workflowSignaled": workflow_signaled}


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
    - permissions: all AccessPermission.data[]
    - requests:    all PermissionRequestModel.data[]
    - notifications: unread Notification.data[]
    All fetched in parallel.
    """
    async def fetch_permissions():
        res = await db.execute(select(AccessPermission).order_by(AccessPermission.id))
        return [r.data for r in res.scalars().all()]

    async def fetch_requests():
        res = await db.execute(select(PermissionRequestModel).order_by(PermissionRequestModel.created_at.desc()))
        return [r.data for r in res.scalars().all()]

    async def fetch_unread_notifications():
        res = await db.execute(
            select(Notification)
            .where(
                (Notification.data["read"].astext != "true")
                | Notification.data["read"].astext.is_(None)
            )
            .order_by(Notification.created_at.desc())
            .limit(100)
        )
        return [n.data for n in res.scalars().all()]

    permissions = await fetch_permissions()
    requests = await fetch_requests()
    notifications = await fetch_unread_notifications()

    return {
        "permissions":    permissions,
        "requests":       requests,
        "notifications":  notifications,
    }


# ---------------------------------------------------------------------------
# Helper: map permission state to person status
# ---------------------------------------------------------------------------

_STATE_TO_PERSON_STATUS: dict[str, str] = {
    "active":            "active",
    "pre_approved":      "pre_approved",
    "restricted":        "restricted",
    "expired":           "expired",
    "pending_approval":  "pending_approval",
}


# ---------------------------------------------------------------------------
# PATCH /v1/permissions/{subject_id}  — update permission with cascades
# ---------------------------------------------------------------------------

@router.patch("/v1/permissions/{subject_id}")
async def update_permission(
    subject_id: str,
    payload: dict[str, Any] = Body(...),
    db: AsyncSession = Depends(get_db),
    _admin: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    """
    Merge-patch an access permission and cascade updates to Person / HardwareAsset.
    Also inserts an AuditEvent and Notification row.
    """
    now = datetime.now(timezone.utc)

    unknown = set(payload) - {"subjectId", "state", "zones", "validFrom", "validTo", "reason"}
    if unknown or payload.get("subjectId", subject_id) != subject_id:
        raise HTTPException(422, "Unsupported permission update")
    if "state" in payload and payload["state"] not in {"active", "restricted", "pending_approval", "expired", "revoked"}:
        raise HTTPException(422, "Unsupported permission state")
    if "zones" in payload:
        payload["zones"] = validate_zones(payload["zones"])
    subject = await db.scalar(select(Subject).where(Subject.id == subject_id).with_for_update())
    if not subject:
        raise HTTPException(404, "Subject not found")

    # 1. Fetch permission
    perm_res = await db.execute(
        select(AccessPermission).where(AccessPermission.subject_id == subject_id).order_by(AccessPermission.id).limit(1)
    )
    perm = perm_res.scalars().first()
    if not perm:
        raise HTTPException(status_code=404, detail="Access permission not found")

    is_first_grant = not perm.data.get("state")
    audit_action = "Manual permission granted" if is_first_grant else "Manual permission changed"

    # 2. Merge payload into existing data
    merged_data = {
        **(perm.data or {}),
        **payload,
        "updatedAt": now.isoformat(),
        "updatedBy":  _admin.get("sub", "unknown"),
    }
    validate_window(merged_data.get("validFrom"), merged_data.get("validTo"))
    perm.data = merged_data

    new_state: str = merged_data.get("state", "")

    # 3. Fetch Person and HardwareAsset (parallel)
    person_res = await db.execute(select(Person).where(Person.subject_id == subject_id))
    hw_res = await db.execute(select(HardwareAsset).where(HardwareAsset.subject_id == subject_id))
    person = person_res.scalar_one_or_none()
    hw = hw_res.scalar_one_or_none()

    # 4. Cascade to Person
    if person:
        person_status = _STATE_TO_PERSON_STATUS.get(new_state, "inactive")
        if subject.kind == "visitor" and new_state == "active":
            person_status = "pre_approved"
        person.data = {
            **(person.data or {}),
            "status": person_status,
            **({"allowedZones": merged_data["zones"]} if isinstance(merged_data.get("zones"), list) else {}),
            "validFrom": merged_data.get("validFrom") or "",
            "validTo": merged_data.get("validTo") or "",
        }

    # 5. Cascade to HardwareAsset
    if hw:
        hw_status = "active" if new_state == "active" else "restricted"
        hw.data = {
            **(hw.data or {}),
            "status": hw_status,
            **({"allowedZones": merged_data["zones"]} if isinstance(merged_data.get("zones"), list) else {}),
            "validFrom": merged_data.get("validFrom") or "",
            "validTo": merged_data.get("validTo") or "",
        }

    # 6. Insert AuditEvent
    audit_id = str(uuid.uuid4())
    audit_data: dict[str, Any] = {
        "id":         audit_id,
        "category":   "permission",
        "action":     audit_action,
        "subjectId":  subject_id,
        "state":      new_state,
        "timestamp":  now.isoformat(),
        "performedBy": _admin.get("sub", "unknown"),
    }
    audit_event = AuditEvent(
        id=audit_id,
        created_at=now,
        data=audit_data,
    )
    db.add(audit_event)

    # 7. Insert Notification
    notif_id = str(uuid.uuid4())
    notif_data: dict[str, Any] = {
        "id":        notif_id,
        "type":      "permission_updated",
        "subjectId": subject_id,
        "action":    audit_action,
        "state":     new_state,
        "timestamp": now.isoformat(),
        "read":      False,
    }
    notification = Notification(
        id=notif_id,
        created_at=now,
        data=notif_data,
    )
    db.add(notification)

    await db.commit()
    await db.refresh(perm)

    return {
        "permission":    perm.data,
        "person":        person.data if person else None,
        "hardwareAsset": hw.data if hw else None,
        "auditEvent":    audit_data,
        "notification":  notif_data,
    }
