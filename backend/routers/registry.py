"""
Phase 3 — Registry CRUD endpoints.

Manage subjects (employees, visitors, hardware) and their associated metadata.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy import select, func, exc
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db, get_read_db
from models import Subject, Person, HardwareAsset
from schemas import SubjectCreate, SubjectUpdate, SubjectResponse, SubjectListResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/registry/subjects", tags=["registry"])

_MAX_LIMIT = 200
_DEFAULT_LIMIT = 50


@router.get("", response_model=SubjectListResponse)
async def list_subjects(
    kind: Optional[str] = Query(None, pattern="^(employee|visitor|hardware)$"),
    limit: int = Query(_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_read_db),
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
async def get_subject(subject_id: str, db: AsyncSession = Depends(get_read_db)) -> SubjectResponse:
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
    payload: SubjectCreate, db: AsyncSession = Depends(get_db)
) -> SubjectResponse:
    """Create a new subject along with their metadata."""
    new_sub = Subject(kind=payload.kind, barcode=payload.barcode)
    
    if payload.kind in ("employee", "visitor"):
        new_sub.person = Person(data=payload.data)
    elif payload.kind == "hardware":
        new_sub.hardware = HardwareAsset(data=payload.data)

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

    return SubjectResponse(
        id=new_sub.id, barcode=new_sub.barcode, kind=new_sub.kind, data=payload.data
    )


@router.put("/{subject_id}", response_model=SubjectResponse)
async def update_subject(
    subject_id: str, payload: SubjectUpdate, db: AsyncSession = Depends(get_db)
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
async def delete_subject(subject_id: str, db: AsyncSession = Depends(get_db)):
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
