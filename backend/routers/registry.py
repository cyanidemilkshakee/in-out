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
from models import AccessPermission, Alert, Subject, Person, HardwareAsset
from schemas import SubjectCreate, SubjectUpdate, SubjectResponse, SubjectListResponse
from temporal_worker import get_temporal_client, TASK_QUEUE
from workflows.visitor_approval import VisitorApprovalWorkflow

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/registry/subjects", tags=["registry"])
bundle_router = APIRouter(prefix="/v1/registry", tags=["registry"])

_MAX_LIMIT = 200
_DEFAULT_LIMIT = 50


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
    data = {"status": "pending_approval" if payload.kind == "visitor" else "active",
        "inside": False, "phone": "", "accessLevel": "Standard",
        "allowedZones": [payload.data["allowedZone"]] if payload.data.get("allowedZone") else [],
        "createdAt": datetime.now(timezone.utc).isoformat(), **payload.data,
        "id": subject_id, "barcode": payload.barcode, "type": payload.kind}
    new_sub = Subject(id=subject_id, kind=payload.kind, barcode=payload.barcode)
    
    if payload.kind in ("employee", "visitor"):
        new_sub.person = Person(data=data)
    elif payload.kind == "hardware":
        new_sub.hardware = HardwareAsset(data=data)

    db.add(new_sub)
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
        try:
            client = await get_temporal_client()
            await client.start_workflow(
                VisitorApprovalWorkflow.run,
                args=[new_sub.id],
                id=f"visitor-{new_sub.id}",
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
    alerts = [alert.data for alert in (await db.execute(
        select(Alert).order_by(Alert.created_at.desc()).limit(200)
    )).scalars().all()]
    permissions = [permission.data for permission in (await db.execute(
        select(AccessPermission).order_by(AccessPermission.id)
    )).scalars().all()]
    return {"people": people, "hardwareAssets": hardware, "alerts": alerts, "permissions": permissions}
