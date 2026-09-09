import uuid
import logging
from datetime import datetime, timezone
from typing import Optional, Dict, Any

from fastapi import APIRouter, Depends, HTTPException, Body, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.dialects.postgresql import insert as pg_insert
import asyncio

from auth import verify_admin_request
from database import get_db, get_read_db
from models import (
    Subject, PermissionRequestModel, PresenceState, Movement, Checkpoint,
    AccessPermission, Person, HardwareAsset, AuditEvent, Notification,
)
from schemas import PermissionRequestCreate, PermissionDecision
from redis_client import publish_presence_update
import json
from temporal_worker import get_temporal_client, TASK_QUEUE
from workflows.permission_override import PermissionOverrideWorkflow

logger = logging.getLogger(__name__)

router = APIRouter(tags=["permissions"])


# ===========================================================================
# ORIGINAL endpoints (prefix: /v1/permission-requests)
# ===========================================================================

@router.post("/v1/permission-requests")
async def create_permission_request(
    payload: PermissionRequestCreate,
    db: AsyncSession = Depends(get_db)
):
    stmt = select(Subject).where(Subject.id == payload.subject_id)
    subject = (await db.execute(stmt)).scalar_one_or_none()
    if not subject:
        raise HTTPException(status_code=404, detail="Subject not found")

    now = datetime.now(timezone.utc)
    req_id = f"REQ-{uuid.uuid4().hex[:8].upper()}"

    data = {
        "id": req_id,
        "subjectId": subject.id,
        "subjectName": "Unknown", # We''d join Person/Hardware here, but keeping it simple
        "type": payload.request_type,
        "purpose": payload.reason,
        "checkpointId": payload.checkpoint_id,
        "status": "pending",
        "createdAt": now.isoformat()
    }

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

    if req_type == "manual_override":
        workflow_id = f"override-{req_id}"
    elif req_type == "visitor":
        workflow_id = f"visitor-{req.data.get('subjectId', '')}" # assuming visitor workflows use subject id
    else:
        raise HTTPException(status_code=400, detail="Cannot decide this request type via Temporal yet")

    try:
        client = await get_temporal_client()
        handle = client.get_workflow_handle(workflow_id)

        # Admin info from JWT
        admin_id = admin.get("sub", "unknown")

        await handle.signal(
            "admin_decision",
            args=[payload.decision, admin_id, payload.reason or ""]
        )

        # Optionally wait briefly for workflow to process the signal and update status
        # but returning HTTP 202 Accepted is also fine.
        return {"status": "decision_submitted", "request_id": req_id}

    except Exception as e:
        logger.exception("Failed to signal workflow")
        raise HTTPException(status_code=500, detail="Failed to process decision")


# ===========================================================================
# NEW endpoints
# ===========================================================================

# ---------------------------------------------------------------------------
# GET /v1/permissions  — consolidated read (no auth required)
# ---------------------------------------------------------------------------

@router.get("/v1/permissions")
async def list_permissions(
    db: AsyncSession = Depends(get_read_db),
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
        select(AccessPermission).where(AccessPermission.subject_id == subject_id)
    )
    perm = perm_res.scalar_one_or_none()
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
        person.data = {**(person.data or {}), "status": person_status}

    # 5. Cascade to HardwareAsset
    if hw:
        hw_status = "restricted" if new_state in ("restricted", "revoked") else "active"
        hw.data = {**(hw.data or {}), "status": hw_status}

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
