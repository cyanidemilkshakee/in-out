"""
Phase 3 — Registry CRUD endpoints.

Manage subjects (employees, visitors, hardware) and their associated metadata.
"""

import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy import select, func, exc, delete, or_
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db, get_read_db
from auth import verify_admin_or_operator_request, verify_admin_request, has_admin_role
from terminal_assignments import browser_identity, require_checkpoint
from models import (
    AccessPermission,
    AuditEvent,
    Alert,
    Movement,
    Subject,
    Person,
    HardwareAsset,
    PermissionRequestModel,
    Checkpoint,
)
from schemas import SubjectCreate, SubjectUpdate, SubjectResponse, SubjectListResponse
from temporal_worker import get_temporal_client, TASK_QUEUE
from workflows.visitor_approval import VisitorApprovalWorkflow
from access_validation import validate_checkpoint_id, validate_window, validate_permission_window, validate_zones
from facility_zones import CHECKPOINT_IDS, normalize_facility_document
from permission_decisions import publish_decision
from redis_client import publish_data_changed
from subject_metadata import current_subject_metadata

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
    "owner": 100,
    "category": 80,
}


def _validated_metadata(payload: SubjectCreate) -> dict[str, Any]:
    """Normalize user-entered metadata before it reaches the JSON columns."""
    incoming = current_subject_metadata(payload.kind, payload.data)
    incoming.pop("entryRestriction", None)
    if payload.kind == "visitor":
        incoming.pop("phone", None)
    if "allowedZone" in incoming:
        zones = validate_zones([incoming["allowedZone"]])
        incoming["allowedZone"] = zones[0] if len(zones) == 1 else "All Zones"
    incoming = normalize_facility_document(incoming)
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

    for field in ("validFrom", "validTo", "validUntil"):
        value = incoming.get(field)
        if value is not None:
            if not isinstance(value, str) or not value.strip() or len(value) > 40:
                raise HTTPException(status_code=422, detail=f"{field} must be a valid date-time")
            incoming[field] = value.strip()
    return incoming


def _is_barcode_conflict(error: exc.IntegrityError) -> bool:
    original = error.orig
    constraint = getattr(getattr(original, "diag", None), "constraint_name", None)
    if constraint in {"uq_subjects_barcode_ci", "subjects_barcode_key"}:
        return True
    message = str(original or error).casefold()
    return "barcode" in message and ("duplicate" in message or "unique" in message)


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

    rows_result = await db.execute(base.order_by(Subject.id).limit(limit).offset(offset))
    subjects = rows_result.scalars().all()

    items = []
    for sub in subjects:
        data = {}
        if sub.person:
            data = current_subject_metadata(sub.kind, sub.person.data)
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
        data = current_subject_metadata(sub.kind, sub.person.data)
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
    barcode = payload.barcode.strip()
    requested_zones = incoming.get("allowedZones")
    if not isinstance(requested_zones, list):
        requested_zones = [incoming["allowedZone"]] if isinstance(incoming.get("allowedZone"), str) else []
    if payload.kind == "hardware" and incoming.get("status", "active") not in {"active", "restricted", "maintenance"}:
        raise HTTPException(422, "Unsupported hardware status")
    now = datetime.now(timezone.utc)
    valid_from = incoming.get("validFrom") or now.isoformat()
    valid_to = incoming.get("validTo") or incoming.get("validUntil") or ""
    visitor_checkpoint = None
    if payload.kind == "visitor":
        if not incoming.get("validFrom") or not incoming.get("validTo"):
            hours = incoming.get("hours")
            if isinstance(hours, bool) or not isinstance(hours, (int, float)) or not 1 <= hours <= 24:
                raise HTTPException(status_code=422, detail="Visitor valid from and valid to are required")
            valid_from = now.isoformat()
            valid_to = (now + timedelta(hours=hours)).isoformat()
        checkpoint_id = validate_checkpoint_id(incoming.get("checkpointId") or "cp-main")
        if not has_admin_role(actor):
            checkpoint_id = await require_checkpoint(db, browser_identity(actor), checkpoint_id)
        async with db.no_autoflush:
            checkpoint_result = await db.execute(select(Checkpoint).where(Checkpoint.id == checkpoint_id))
        visitor_checkpoint = checkpoint_result.scalar_one_or_none()
        if not visitor_checkpoint:
            raise HTTPException(status_code=422, detail="Checkpoint not registered")
        incoming["checkpointId"] = checkpoint_id
        validate_permission_window(valid_from, valid_to, now=now)
        parsed_valid_to = datetime.fromisoformat(valid_to.replace("Z", "+00:00"))
        if parsed_valid_to.tzinfo is None:
            parsed_valid_to = parsed_valid_to.replace(tzinfo=timezone(timedelta(hours=5, minutes=30)))
        if parsed_valid_to <= now:
            raise HTTPException(status_code=422, detail="Visitor valid to must be in the future")
    validate_window(valid_from, valid_to)
    if payload.kind != "visitor" and (incoming.get("validFrom") or incoming.get("validTo") or incoming.get("validUntil")):
        validate_permission_window(valid_from, valid_to, now=now)
    if payload.kind == "visitor" and not requested_zones and visitor_checkpoint:
        requested_zones = [visitor_checkpoint.data.get("zone", "public")]
    requested_zones = validate_zones(requested_zones)
    if payload.kind == "visitor":
        incoming["validFrom"] = valid_from
        incoming["validTo"] = valid_to
    data = {
        **incoming,
        # Server-owned fields must be applied last. Operators cannot create an
        # already-approved visitor or smuggle a different identity into the
        # registry payload.
        "status": "pending_approval" if payload.kind == "visitor" else incoming.get("status", "active") if payload.kind == "hardware" else "active",
        "inside": False,
        "allowedZones": [zone for zone in requested_zones if isinstance(zone, str)] if has_admin_role(actor) and payload.kind != "visitor" else [],
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "id": subject_id,
        "barcode": barcode,
        "type": payload.kind,
        "validFrom": valid_from,
        "validTo": valid_to,
        "createdAt": now.isoformat(),
    }
    new_sub = Subject(id=subject_id, kind=payload.kind, barcode=barcode)
    
    if payload.kind in ("employee", "visitor"):
        new_sub.person = Person(data=data)
    elif payload.kind == "hardware":
        new_sub.hardware = HardwareAsset(data=data)

    db.add(new_sub)
    if payload.kind in {"employee", "visitor", "hardware"}:
        permission_id = str(uuid.uuid4())
        db.add(AccessPermission(
            id=permission_id,
            subject_id=subject_id,
            data={
                "id": permission_id,
                "subjectId": subject_id,
                "subjectName": data.get("name") or barcode,
                "subjectType": payload.kind,
                "assignment": "Temporary visitor" if payload.kind == "visitor" else payload.kind.title(),
                "state": "pending_approval" if payload.kind == "visitor" else "active" if data["status"] == "active" else "restricted",
                "zones": data.get("allowedZones") or [],
                "validFrom": data.get("validFrom") or "",
                "validTo": data.get("validTo") or data.get("validUntil") or "",
                "source": "request" if payload.kind == "visitor" else "policy",
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "updatedBy": actor.get("sub", "Terminal Operator"),
            },
        ))
    visitor_request = None
    if payload.kind == "visitor":
        request_id = f"REQ-{uuid.uuid4().hex[:8].upper()}"
        checkpoint_id = visitor_checkpoint.id
        checkpoint_name = visitor_checkpoint.data.get("name", checkpoint_id)
        visitor_request = {
            "id": request_id,
            "subjectId": subject_id,
            "subjectName": data.get("name") or payload.barcode,
            "barcode": barcode,
            "subjectType": "visitor",
            "type": "visitor",
            "purpose": data.get("purpose") or data.get("reason") or "Temporary visitor access",
            "checkpointId": checkpoint_id,
            "checkpoint": checkpoint_name,
            "requester": actor.get("sub", "Terminal Operator"),
            "requestedZones": requested_zones,
            "validFrom": data.get("validFrom") or now.isoformat(),
            "validTo": data.get("validTo") or data.get("validUntil") or now.isoformat(),
            "status": "pending",
            "createdAt": now.isoformat(),
        }
        db.add(PermissionRequestModel(id=request_id, subject_id=subject_id, data=visitor_request, created_at=now))

    try:
        await db.commit()
        await db.refresh(new_sub)
    except exc.IntegrityError as error:
        await db.rollback()
        if _is_barcode_conflict(error):
            raise HTTPException(status_code=409, detail="This barcode is already registered")
        logger.exception("Registry integrity error while creating subject")
        raise HTTPException(status_code=500, detail="Unable to register subject")
    except Exception:
        await db.rollback()
        logger.exception("Error creating subject")
        raise HTTPException(status_code=500, detail="Internal server error")

    if visitor_request:
        await publish_decision({"request": visitor_request, "person": data})
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
    else:
        await publish_data_changed()

    return SubjectResponse(id=new_sub.id, barcode=new_sub.barcode, kind=new_sub.kind, data=data, request=visitor_request)


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
        .with_for_update()
    )
    result = await db.execute(stmt)
    sub = result.scalar_one_or_none()

    if not sub:
        raise HTTPException(status_code=404, detail="Subject not found")

    if payload.barcode is not None:
        sub.barcode = payload.barcode

    patch = {key: value for key, value in (payload.data or {}).items()
             if key not in {"id", "type", "kind", "barcode", "inside", "entryOverride", "entryRestriction", "createdAt"}}
    patch = current_subject_metadata(sub.kind, patch)
    if "allowedZone" in patch:
        zones = validate_zones([patch["allowedZone"]])
        patch["allowedZone"] = zones[0] if len(zones) == 1 else "All Zones"
        patch.setdefault("allowedZones", zones)
    if "allowedZones" in patch:
        patch["allowedZones"] = validate_zones(patch["allowedZones"])
    if "status" in patch:
        statuses = {"active", "restricted", "maintenance"} if sub.kind == "hardware" else {"active", "inactive", "pre_approved", "pending_approval", "restricted", "expired"}
        if patch["status"] not in statuses:
            raise HTTPException(422, "Unsupported registry status")
    for field, limit in _METADATA_LIMITS.items():
        if field in patch and (not isinstance(patch[field], str) or not patch[field].strip() or len(patch[field]) > limit):
            raise HTTPException(422, f"{field} must be non-empty text of at most {limit} characters")

    current_data = {}
    if payload.data is not None:
        if sub.kind in ("employee", "visitor"):
            if not sub.person:
                sub.person = Person(data={})
            sub.person.data = {**sub.person.data, **patch}
            current_data = sub.person.data
        elif sub.kind == "hardware":
            if not sub.hardware:
                sub.hardware = HardwareAsset(data={})
            sub.hardware.data = {**sub.hardware.data, **patch}
            current_data = sub.hardware.data
    else:
        if sub.person:
            current_data = sub.person.data
        elif sub.hardware:
            current_data = sub.hardware.data

    current_data = {**current_subject_metadata(sub.kind, current_data), "id": sub.id, "barcode": sub.barcode, "type": sub.kind}
    validate_window(current_data.get("validFrom"), current_data.get("validTo"))
    if "validFrom" in patch or "validTo" in patch:
        validate_permission_window(current_data.get("validFrom"), current_data.get("validTo"),
            allow_past_start="validFrom" not in patch)
    metadata = sub.hardware if sub.kind == "hardware" else sub.person
    if metadata:
        metadata.data = current_data
    permission = await db.scalar(select(AccessPermission).where(AccessPermission.subject_id == sub.id))
    if permission:
        permission_data = {**permission.data, "subjectName": current_data.get("name", sub.barcode),
            "updatedAt": datetime.now(timezone.utc).isoformat(), "updatedBy": _admin.get("sub", "unknown")}
        for source, target in (("allowedZones", "zones"), ("validFrom", "validFrom"), ("validTo", "validTo")):
            if source in patch:
                permission_data[target] = patch[source]
        if "status" in patch:
            permission_data["state"] = {"pre_approved": "active", "inactive": "revoked", "maintenance": "restricted"}.get(patch["status"], patch["status"])
        permission.data = permission_data
    try:
        await db.commit()
    except exc.IntegrityError as error:
        await db.rollback()
        if _is_barcode_conflict(error):
            raise HTTPException(status_code=409, detail="This barcode is already registered")
        logger.exception("Registry integrity error while updating subject")
        raise HTTPException(status_code=500, detail="Unable to update subject")
    except Exception:
        await db.rollback()
        logger.exception("Error updating subject")
        raise HTTPException(status_code=500, detail="Internal server error")

    await publish_data_changed()

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

    try:
        # Let database cascades remove metadata/presence while history FKs
        # protect subjects that have already participated in a scan/review.
        await db.execute(delete(Subject).where(Subject.id == subject_id))
        await db.commit()
    except exc.IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Subject has recorded history; restrict access instead of deleting it")
    except Exception:
        await db.rollback()
        logger.exception("Error deleting subject")
        raise HTTPException(status_code=500, detail="Internal server error")

    await publish_data_changed()


@bundle_router.get("/bundle")
async def registry_bundle(db: AsyncSession = Depends(get_read_db)) -> dict[str, Any]:
    """Return the complete registry read model in one admin request."""
    subjects = (await db.execute(
        select(Subject).options(
            selectinload(Subject.person),
            selectinload(Subject.hardware),
            selectinload(Subject.presence_state),
        ).order_by(Subject.id)
    )).scalars().all()
    from critical_entry_restrictions import entry_restrictions_for_subjects
    restrictions = await entry_restrictions_for_subjects(db, [subject.id for subject in subjects])
    people = []
    hardware = []
    for subject in subjects:
        presence = subject.presence_state.state == "inside" if subject.presence_state else False
        if subject.person:
            people.append({
                **current_subject_metadata(subject.kind, subject.person.data),
                "id": subject.id,
                "barcode": subject.barcode,
                "type": subject.kind,
                "inside": presence,
                "entryRestriction": restrictions.get(subject.id),
            })
        if subject.hardware:
            hardware.append({
                **(subject.hardware.data or {}),
                "id": subject.id,
                "barcode": subject.barcode,
                "inside": presence,
                "entryRestriction": restrictions.get(subject.id),
            })
    permissions = [permission.data for permission in (await db.execute(
        select(AccessPermission).order_by(AccessPermission.id)
    )).scalars().all()]
    excluded_alert = or_(
        (Alert.data["manualReview"].astext == "true")
        | (Alert.data["ruleId"].astext == "rule-manual-review")
        | (Alert.data["ruleId"].astext == "rule-unknown-barcode")
        | Alert.data["title"].astext.ilike("Unknown barcode%")
    )
    alerts = [alert.data for alert in (await db.execute(
        select(Alert)
        .where(~func.coalesce(excluded_alert, False))
        .order_by(Alert.created_at.desc())
        .limit(200)
    )).scalars().all()]
    movement_rows = (await db.execute(
        select(Movement).order_by(Movement.occurred_at.desc(), Movement.id).limit(1000)
    )).scalars().all()
    movements = []
    for movement in movement_rows:
        occurred_at = movement.occurred_at.isoformat() if movement.occurred_at else None
        movements.append({
            **(movement.data or {}),
            "id": movement.id,
            "subject_id": movement.subject_id,
            "checkpoint_id": movement.checkpoint_id,
            "occurred_at": occurred_at,
            "denial_code": movement.denial_code,
            "result": movement.result,
            "direction": movement.direction,
            "scan_type": movement.scan_type,
            "subject_type": movement.subject_type,
            "sync_state": movement.sync_state,
            "createdAt": (movement.data or {}).get("createdAt") or occurred_at,
        })
    audit_rows = (await db.execute(
        select(AuditEvent).order_by(AuditEvent.created_at.desc(), AuditEvent.id).limit(500)
    )).scalars().all()
    request_rows = (await db.execute(
        select(PermissionRequestModel).where(PermissionRequestModel.id.in_(
            [str((event.data or {}).get("relatedId") or "") for event in audit_rows]
        ))
    )).scalars().all()
    request_by_id = {request.id: request.data or {} for request in request_rows}
    subject_by_id = {subject.id: subject for subject in subjects}
    audit_events = []
    for event in audit_rows:
        data = event.data or {}
        request = request_by_id.get(str(data.get("relatedId") or ""), {})
        subject = subject_by_id.get(str(data.get("subjectId") or ""))
        subject_metadata = (subject.person.data if subject and subject.person else subject.hardware.data if subject and subject.hardware else {}) or {}
        audit_events.append({
            **data,
            "id": event.id,
            "subjectName": data.get("subjectName") or request.get("subjectName") or subject_metadata.get("name") or (subject.barcode if subject else "Unregistered barcode"),
            "barcode": data.get("barcode") or request.get("barcode") or (subject.barcode if subject else ""),
            "createdAt": data.get("createdAt") or (event.created_at.isoformat() if event.created_at else None),
        })
    return {
        "people": people,
        "hardwareAssets": hardware,
        "alerts": alerts,
        "permissions": permissions,
        "movements": movements,
        "auditEvents": audit_events,
        "permissionRequests": [request.data for request in (await db.execute(
            select(PermissionRequestModel)
            .order_by(PermissionRequestModel.created_at.desc())
        )).scalars().all()],
        "checkpoints": [{**(checkpoint.data or {}), "id": checkpoint.id} for checkpoint in (await db.execute(
            select(Checkpoint).where(Checkpoint.id.in_(CHECKPOINT_IDS)).order_by(Checkpoint.id)
        )).scalars().all()],
    }
