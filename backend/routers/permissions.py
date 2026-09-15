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

    data = {
        "id": req_id,
        "subjectId": subject.id,
        "subjectName": payload.subject_name or subject_data.get("name") or subject.barcode,
        "subjectType": subject.kind,
        "barcode": subject.barcode,
        "type": payload.request_type,
        "purpose": payload.reason,
        "checkpointId": payload.checkpoint_id,
        "checkpoint": checkpoint_name,
        "requester": payload.requester or actor.get("sub") or "Terminal Operator",
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
    if payload.direction:
        data["direction"] = payload.direction

    req_model = PermissionRequestModel(
        id=req_id,
        subject_id=subject.id,
        data=data,
        created_at=now
    )
    db.add(req_model)
    await db.commit()

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
    # Fetch existing to check type
    stmt = select(PermissionRequestModel).where(PermissionRequestModel.id == req_id)
    req = (await db.execute(stmt)).scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")

    req_type = req.data.get("type")

    if req.data.get("status") != "pending":
        raise HTTPException(status_code=409, detail="Permission request has already been decided")

    if req_type == "manual_override":
        workflow_id = f"override-{req_id}"
    elif req_type == "visitor":
        workflow_id = f"visitor-{req_id}"
    else:
        raise HTTPException(status_code=400, detail="Cannot decide this request type via Temporal yet")

    # Persist immediately so Permission Manager and the terminal queue reflect
    # Allow/Deny without waiting for the workflow activity to finish.
    admin_id = admin.get("sub", "unknown")
    updated_request = {**req.data, "status": payload.decision}
    updated_request["decidedAt"] = datetime.now(timezone.utc).isoformat()
    updated_request["decidedBy"] = admin_id
    req.data = updated_request
    await db.commit()

    # A terminal review is applied synchronously before signaling Temporal.
    # This guarantees the movement, audit log, and dashboard are updated even
    # when the workflow has already timed out or is temporarily unavailable.
    if req_type == "manual_override":
        try:
            from workflows.activities import approve_override, deny_override

            if payload.decision == "approved":
                await approve_override(
                    req_id, admin_id,
                    payload.reason or "Approved by Permission Manager after policy review",
                )
            else:
                await deny_override(
                    req_id,
                    payload.reason or "Denied by Permission Manager after policy review",
                )
        except Exception:
            logger.exception("Failed to apply manual override decision")
            # Activity commits are atomic, but presence publication happens
            # after the commit. If an exception occurred after persistence,
            # keep the completed decision; otherwise return the request to
            # pending so the operator can retry instead of hiding a partial
            # approval/denial behind a successful response.
            movement_check = await db.execute(
                select(Movement)
                .where(Movement.data["overrideRequestId"].astext == req_id)
                .limit(1)
            )
            if movement_check.scalars().first() is None:
                reverted_request = dict(req.data)
                reverted_request["status"] = "pending"
                reverted_request.pop("decidedAt", None)
                reverted_request.pop("decidedBy", None)
                req.data = reverted_request
                await db.commit()
                raise HTTPException(
                    status_code=503,
                    detail="Manual decision could not be applied. Please retry.",
                )

    workflow_signaled = False
    try:
        client = await get_temporal_client()
        handle = client.get_workflow_handle(workflow_id)
        signal_args = (
            [payload.decision, admin_id, payload.reason or ""]
            if req_type == "manual_override"
            else [payload.decision, payload.reason or ""]
        )
        await handle.signal("admin_decision", args=signal_args)
        workflow_signaled = True
    except Exception:
        # The decision and (for terminal reviews) its movement are already
        # committed. Temporal can reconcile later if it becomes available.
        logger.exception("Failed to signal workflow after decision was applied")

    movement_data = None
    audit_data = None
    if req_type == "manual_override":
        movement_result = await db.execute(
            select(Movement)
            .where(Movement.data["overrideRequestId"].astext == req_id)
            .order_by(Movement.occurred_at.desc())
            .limit(1)
        )
        movement = movement_result.scalars().first()
        if movement:
            movement_data = {
                **(movement.data or {}),
                "id": movement.id,
                "subjectId": movement.subject_id or (movement.data or {}).get("subjectId", ""),
                "checkpointId": movement.checkpoint_id,
                "result": movement.result,
                "direction": movement.direction,
                "scanType": movement.scan_type,
                "subjectType": movement.subject_type,
                "syncState": movement.sync_state,
                "denialCode": movement.denial_code,
                "createdAt": movement.occurred_at.isoformat() if movement.occurred_at else None,
            }
        audit_result = await db.execute(
            select(AuditEvent)
            .where(AuditEvent.data["relatedId"].astext == req_id)
            .order_by(AuditEvent.created_at.desc())
            .limit(1)
        )
        audit = audit_result.scalars().first()
        audit_data = audit.data if audit else None

    return {
        "request": updated_request,
        "workflowSignaled": workflow_signaled,
        "movement": movement_data,
        "auditEvent": audit_data,
    }


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
                | Notification.data["read"].is_(None)
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
        "updatedBy":  "Admin User",
    }
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
        if person.data.get("type") == "visitor" and new_state == "active":
            person_status = "pre_approved"
        person.data = {
            **(person.data or {}),
            "status": person_status,
            **({"allowedZones": merged_data["zones"]} if isinstance(merged_data.get("zones"), list) else {}),
            **({"validFrom": merged_data["validFrom"]} if merged_data.get("validFrom") else {}),
            **({"validTo": merged_data["validTo"]} if merged_data.get("validTo") else {}),
        }

    # 5. Cascade to HardwareAsset
    if hw:
        hw_status = "restricted" if new_state in ("restricted", "revoked") else "active"
        hw.data = {
            **(hw.data or {}),
            "status": hw_status,
            **({"allowedZones": merged_data["zones"]} if isinstance(merged_data.get("zones"), list) else {}),
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
        "performedBy": "Admin User",
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
