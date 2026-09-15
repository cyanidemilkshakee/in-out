"""
Phase 3 — Registry CRUD endpoints.

Manage subjects (employees, visitors, hardware) and their associated metadata.
"""

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy import select, func, exc
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db, get_read_db
from auth import verify_admin_or_operator_request, verify_admin_request, has_admin_role
from models import AccessPermission, Alert, Subject, Person, HardwareAsset, PermissionRequestModel, Checkpoint
from schemas import SubjectCreate, SubjectUpdate, SubjectResponse, SubjectListResponse
from temporal_worker import get_temporal_client, TASK_QUEUE
from workflows.visitor_approval import VisitorApprovalWorkflow

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/registry/subjects", tags=["registry"])
bundle_router = APIRouter(prefix="/v1/registry", tags=["registry"])

_MAX_LIMIT = 200
_DEFAULT_LIMIT = 50
_METADATA_LIMITS = {
    "name": 100,
    "company": 120,
    "host": 100,
    "reason": 240,
    "purpose": 240,
    "department": 100,
    "owner": 100,
    "category": 80,
}


def _validated_metadata(payload: SubjectCreate) -> dict[str, Any]:
    """Normalize user-entered metadata before it reaches the JSON columns."""
    incoming = dict(payload.data or {})
    for field, limit in _METADATA_LIMITS.items():
        value = incoming.get(field)
        if value is None:
            continue
        if not isinstance(value, str):
            raise HTTPException(status_code=422, detail=f"{field} must be text")
        value = value.strip()
        if not value:
            raise HTTPException(status_code=422, detail=f"{field} cannot be empty")
        if len(value) > limit:
            raise HTTPException(status_code=422, detail=f"{field} must be {limit} characters or fewer")
        incoming[field] = value

    if payload.kind in {"employee", "visitor"}:
        for field in ("name", "host") if payload.kind == "visitor" else ("name",):
            if not str(incoming.get(field) or "").strip():
                raise HTTPException(status_code=422, detail=f"{field} is required")

    if payload.kind == "visitor":
        hours = incoming.get("hours")
        if isinstance(hours, bool) or not isinstance(hours, (int, float)) or not 1 <= hours <= 24:
            raise HTTPException(status_code=422, detail="hours must be between 1 and 24")

    for field in ("validFrom", "validUntil"):
        value = incoming.get(field)
        if value is not None:
            if not isinstance(value, str) or not value.strip() or len(value) > 40:
                raise HTTPException(status_code=422, detail=f"{field} must be a valid date-time")
            incoming[field] = value.strip()
    return incoming


@router.get("", response_model=SubjectListResponse)
async def list_subjects(
    kind: Optional[str] = Query(None, pattern="^(employee|visitor|hardware)$"),
    limit: int = Query(_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_read_db),
    _admin: dict = Depends(verify_admin_request),
) -> SubjectListResponse:
    """List subjects with pagination and optional filtering by kind."""
    base = select(Subject).options(selectinload(Subject.person), selectinload(Subject.hardware))
    count_base = select(func.count()).select_from(Subject)

    if kind:
        base = base.where(Subject.kind == kind)
        count_base = count_base.where(Subject.kind == kind)

    total_result = await db.execute(count_base)
    total = total_result.scalar_one()

    rows_result = await db.execute(base.limit(limit).offset(offset))
    subjects = rows_result.scalars().all()

    items = []
    for sub in subjects:
        data = {}
        if sub.person:
            data = sub.person.data
        elif sub.hardware:
            data = sub.hardware.data
        
        items.append(SubjectResponse(
            id=sub.id,
            barcode=sub.barcode,
            kind=sub.kind,
            data=data
        ))

    return SubjectListResponse(items=items, total=total, limit=limit, offset=offset)


@router.get("/{subject_id}", response_model=SubjectResponse)
async def get_subject(
    subject_id: str,
    db: AsyncSession = Depends(get_read_db),
    _admin: dict = Depends(verify_admin_request),
) -> SubjectResponse:
    """Get a specific subject by ID."""
    stmt = (
        select(Subject)
        .options(selectinload(Subject.person), selectinload(Subject.hardware))
        .where(Subject.id == subject_id)
    )
    result = await db.execute(stmt)
    sub = result.scalar_one_or_none()

    if not sub:
        raise HTTPException(status_code=404, detail="Subject not found")

    data = {}
    if sub.person:
        data = sub.person.data
    elif sub.hardware:
        data = sub.hardware.data

    return SubjectResponse(id=sub.id, barcode=sub.barcode, kind=sub.kind, data=data)


@router.post("", response_model=SubjectResponse, status_code=201)
async def create_subject(
    payload: SubjectCreate,
    db: AsyncSession = Depends(get_db),
    actor: dict = Depends(verify_admin_or_operator_request),
) -> SubjectResponse:
    """Create a new subject along with their metadata."""
    if not has_admin_role(actor) and payload.kind != "visitor":
        raise HTTPException(status_code=403, detail="Terminal operators may create temporary visitors only")
    subject_id = str(uuid.uuid4())
    incoming = _validated_metadata(payload)
    requested_zones = incoming.get("allowedZones")
    if not isinstance(requested_zones, list):
        requested_zones = []
    data = {
        **incoming,
        # Server-owned fields must be applied last. Operators cannot create an
        # already-approved visitor or smuggle a different identity into the
        # registry payload.
        "status": "pending_approval" if payload.kind == "visitor" else "active",
        "inside": False,
        "phone": str(incoming.get("phone") or ""),
        "accessLevel": str(incoming.get("accessLevel") or "Standard"),
        "allowedZones": [zone for zone in requested_zones if isinstance(zone, str)] if has_admin_role(actor) else [],
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "id": subject_id,
        "barcode": payload.barcode,
        "type": payload.kind,
    }
    new_sub = Subject(id=subject_id, kind=payload.kind, barcode=payload.barcode)
    
    if payload.kind in ("employee", "visitor"):
        new_sub.person = Person(data=data)
    elif payload.kind == "hardware":
        new_sub.hardware = HardwareAsset(data=data)

    db.add(new_sub)
    if payload.kind == "visitor":
        permission_id = str(uuid.uuid4())
        db.add(AccessPermission(
            id=permission_id,
            subject_id=subject_id,
            data={
                "id": permission_id,
                "subjectId": subject_id,
                "subjectName": data.get("name") or payload.barcode,
                "subjectType": "visitor",
                "assignment": "Temporary visitor",
                "state": "pending_approval",
                "zones": data.get("allowedZones") or [],
                "validFrom": data.get("validFrom") or "",
                "validTo": data.get("validTo") or data.get("validUntil") or "",
                "source": "request",
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "updatedBy": actor.get("sub", "Terminal Operator"),
            },
        ))
    try:
        await db.commit()
        await db.refresh(new_sub)
    except exc.IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Barcode already exists")
    except Exception:
        await db.rollback()
        logger.exception("Error creating subject")
        raise HTTPException(status_code=500, detail="Internal server error")

    if payload.kind == "visitor":
        request_id = f"REQ-{uuid.uuid4().hex[:8].upper()}"
        now = datetime.now(timezone.utc)
        checkpoint_result = await db.execute(select(Checkpoint).order_by(Checkpoint.id).limit(1))
        checkpoint = checkpoint_result.scalar_one_or_none()
        checkpoint_id = checkpoint.id if checkpoint else "main-gate"
        checkpoint_name = checkpoint.data.get("name", checkpoint_id) if checkpoint else checkpoint_id
        visitor_request = {
            "id": request_id,
            "subjectId": subject_id,
            "subjectName": data.get("name") or payload.barcode,
            "subjectType": "visitor",
            "type": "visitor",
            "purpose": data.get("purpose") or data.get("reason") or "Temporary visitor access",
            "checkpointId": checkpoint_id,
            "checkpoint": checkpoint_name,
            "requester": actor.get("sub", "Terminal Operator"),
            "requestedZones": data.get("allowedZones") or [checkpoint.data.get("zone", "public")] if checkpoint else ["public"],
            "validFrom": data.get("validFrom") or now.isoformat(),
            "validTo": data.get("validTo") or data.get("validUntil") or now.isoformat(),
            "status": "pending",
            "createdAt": now.isoformat(),
        }
        db.add(PermissionRequestModel(id=request_id, subject_id=subject_id, data=visitor_request, created_at=now))
        await db.commit()
        try:
            client = await get_temporal_client()
            await client.start_workflow(
                VisitorApprovalWorkflow.run,
                args=[request_id],
                id=f"visitor-{request_id}",
                task_queue=TASK_QUEUE,
            )
        except Exception as e:
            logger.exception("Failed to start VisitorApprovalWorkflow")

    return SubjectResponse(
        id=new_sub.id, barcode=new_sub.barcode, kind=new_sub.kind, data=data
    )


@router.put("/{subject_id}", response_model=SubjectResponse)
async def update_subject(
    subject_id: str,
    payload: SubjectUpdate,
    db: AsyncSession = Depends(get_db),
    _admin: dict = Depends(verify_admin_request),
) -> SubjectResponse:
    """Update a subject's barcode and/or JSON metadata."""
    stmt = (
        select(Subject)
        .options(selectinload(Subject.person), selectinload(Subject.hardware))
        .where(Subject.id == subject_id)
    )
    result = await db.execute(stmt)
    sub = result.scalar_one_or_none()

    if not sub:
        raise HTTPException(status_code=404, detail="Subject not found")

    if payload.barcode is not None:
        sub.barcode = payload.barcode

    current_data = {}
    if payload.data is not None:
        if sub.kind in ("employee", "visitor"):
            if not sub.person:
                sub.person = Person(data={})
            # Merge updates or overwrite entirely? We overwrite entirely.
            # If partial merge is desired, it's `sub.person.data = {**sub.person.data, **payload.data}`
            sub.person.data = {**sub.person.data, **payload.data}
            current_data = sub.person.data
        elif sub.kind == "hardware":
            if not sub.hardware:
                sub.hardware = HardwareAsset(data={})
            sub.hardware.data = {**sub.hardware.data, **payload.data}
            current_data = sub.hardware.data
    else:
        if sub.person:
            current_data = sub.person.data
        elif sub.hardware:
            current_data = sub.hardware.data

    try:
        await db.commit()
    except exc.IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Barcode already exists")
    except Exception:
        await db.rollback()
        logger.exception("Error updating subject")
        raise HTTPException(status_code=500, detail="Internal server error")

    return SubjectResponse(id=sub.id, barcode=sub.barcode, kind=sub.kind, data=current_data)


@router.delete("/{subject_id}", status_code=204)
async def delete_subject(
    subject_id: str,
    db: AsyncSession = Depends(get_db),
    _admin: dict = Depends(verify_admin_request),
):
    """Delete a subject. Postgres CASCADE will remove person/hardware associations."""
    stmt = select(Subject).where(Subject.id == subject_id)
    result = await db.execute(stmt)
    sub = result.scalar_one_or_none()

    if not sub:
        raise HTTPException(status_code=404, detail="Subject not found")

    await db.delete(sub)
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        logger.exception("Error deleting subject")
        raise HTTPException(status_code=500, detail="Internal server error")


@bundle_router.get("/bundle")
async def registry_bundle(db: AsyncSession = Depends(get_read_db)) -> dict[str, Any]:
    """Return registry subjects, alerts, and permissions in one admin request."""
    subjects = (await db.execute(
        select(Subject).options(selectinload(Subject.person), selectinload(Subject.hardware)).order_by(Subject.id)
    )).scalars().all()
    people = [{**(subject.person.data or {}), "id": subject.id} for subject in subjects if subject.person]
    hardware = [{**(subject.hardware.data or {}), "id": subject.id} for subject in subjects if subject.hardware]
    manual_review_alert = (
        (Alert.data["manualReview"].astext == "true")
        | (Alert.data["ruleId"].astext == "rule-manual-review")
        | (Alert.data["ruleId"].astext == "rule-unknown-barcode")
        | Alert.data["title"].astext.ilike("Unknown barcode%")
    )
    alerts = [alert.data for alert in (await db.execute(
        select(Alert).where(~manual_review_alert).order_by(Alert.created_at.desc()).limit(200)
    )).scalars().all()]
    permissions = [permission.data for permission in (await db.execute(
        select(AccessPermission).order_by(AccessPermission.id)
    )).scalars().all()]
    return {"people": people, "hardwareAssets": hardware, "alerts": alerts, "permissions": permissions}
