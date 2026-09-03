import uuid
import logging
from datetime import datetime, timezone
from typing import Optional, Dict, Any

from fastapi import APIRouter, Depends, HTTPException, Body
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.dialects.postgresql import insert as pg_insert

from database import get_db
from models import Subject, PermissionRequestModel, PresenceState, Movement, Checkpoint
from schemas import PermissionRequestCreate, PermissionDecision
from redis_client import publish_presence_update
import json

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/permission-requests", tags=["permissions"])

@router.post("")
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
        "subjectName": "Unknown", # We'd join Person/Hardware here, but keeping it simple
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
    
    return data

@router.post("/{req_id}/decide")
async def decide_permission_request(
    req_id: str,
    payload: PermissionDecision,
    db: AsyncSession = Depends(get_db)
):
    stmt = select(PermissionRequestModel).where(PermissionRequestModel.id == req_id)
    req_model = (await db.execute(stmt)).scalar_one_or_none()
    if not req_model:
        raise HTTPException(status_code=404, detail="Permission request not found")
        
    data = dict(req_model.data)
    if data.get("status") != "pending":
        return data
        
    data["status"] = payload.decision
    req_model.data = data
    
    # If it's a manual override and approved, we must generate a movement
    if payload.decision == "approved" and data.get("type") == "manual_override":
        subject_id = data["subjectId"]
        checkpoint_id = data.get("checkpointId", "unknown")

        # Fetch the full subject to get kind and barcode
        subject_stmt = select(Subject).where(Subject.id == subject_id)
        subject_obj = (await db.execute(subject_stmt)).scalar_one_or_none()
        subject_kind = subject_obj.kind if subject_obj else "employee"
        subject_barcode = subject_obj.barcode if subject_obj else "unknown"

        # 1. Update presence state
        lock_stmt = select(PresenceState).where(PresenceState.subject_id == subject_id).with_for_update()
        presence = (await db.execute(lock_stmt)).scalar_one_or_none()
        if not presence:
            presence = PresenceState(subject_id=subject_id, state="outside")
            db.add(presence)
            await db.flush()

        new_state = "inside" if presence.state == "outside" else "outside"
        presence.state = new_state
        now = datetime.now(timezone.utc)
        presence.last_scan_timestamp = now

        # 2. Record movement
        movement = Movement(
            subject_id=subject_id,
            checkpoint_id=checkpoint_id,
            occurred_at=now,
            result="approved",
            direction="entry" if new_state == "inside" else "exit",
            scan_type="manual",
            sync_state="queued",
            subject_type=subject_kind,
            data={}
        )
        db.add(movement)

        # 3. Publish SSE
        await publish_presence_update(json.dumps({
            "subject_id": subject_id,
            "kind": subject_kind,
            "barcode": subject_barcode,
            "state": new_state,
            "timestamp": now.isoformat(),
        }))

    await db.commit()
    return data
