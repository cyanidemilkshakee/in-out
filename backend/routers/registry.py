"""
Phase 3 — Registry CRUD endpoints.

Manage subjects (employees, visitors, hardware) and their associated metadata.
"""

import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy import select, func, exc, delete, or_, false
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db, get_read_db
from data_limits import bounded_rows
from event_outbox import enqueue_changed, enqueue_workflow_start
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
from access_validation import (require_registered_checkpoint, validate_window,
    validate_permission_window, validate_registered_zones)
from permission_decisions import publish_decision, enqueue_decision, permission_version
from redis_client import publish_data_changed
from subject_metadata import current_subject_metadata, validate_subject_metadata_size
from manual_review_policy import revised_access_data
from registry_validation import (
    METADATA_LIMITS as _METADATA_LIMITS,
    is_barcode_conflict as _is_barcode_conflict,
    validated_metadata as _validated_metadata,
)
from zone_access import admin_zone_ids, require_checkpoint_scope, require_subject_scope, subject_zone_condition, validate_zone_subset

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/registry/subjects", tags=["registry"])
bundle_router = APIRouter(prefix="/v1/registry", tags=["registry"])

_MAX_LIMIT = 200
_DEFAULT_LIMIT = 50
async def _hardware_employee(db, employee_id, role):
    if not isinstance(employee_id, str) or not employee_id.strip():
        raise HTTPException(422, f"Choose a registered employee as the hardware {role}")
    employee = await db.scalar(select(Subject).where(
        Subject.id == employee_id.strip(), Subject.kind == "employee")
        .options(selectinload(Subject.person)).execution_options(populate_existing=True))
    if employee is None:
        raise HTTPException(422, f"Hardware {role} must be a registered employee")
    name = (employee.person.data or {}).get("name") if employee.person else None
    name = name.strip() if isinstance(name, str) else ""
    if not name:
        raise HTTPException(422, "Selected employee has no registered name")
    return employee.id, name


@router.get("", response_model=SubjectListResponse)
async def list_subjects(
    kind: Optional[str] = Query(None, pattern="^(employee|visitor|hardware|people)$"),
    limit: int = Query(_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_read_db),
    actor: dict = Depends(verify_admin_request),
    search: Optional[str] = Query(None, max_length=200),
) -> SubjectListResponse:
    """List subjects with pagination and optional filtering by kind."""
    from registry_reads import subject_search_conditions
    zone_ids = await admin_zone_ids(db, actor)
    conditions = [*subject_search_conditions(kind, search), subject_zone_condition(zone_ids)]
    base = select(Subject).outerjoin(Person, Person.subject_id == Subject.id).outerjoin(
        HardwareAsset, HardwareAsset.subject_id == Subject.id).outerjoin(
        AccessPermission, AccessPermission.subject_id == Subject.id).options(selectinload(Subject.person), selectinload(Subject.hardware))
    count_base = select(func.count()).select_from(Subject).outerjoin(Person, Person.subject_id == Subject.id).outerjoin(
        HardwareAsset, HardwareAsset.subject_id == Subject.id).outerjoin(
        AccessPermission, AccessPermission.subject_id == Subject.id)
    base, count_base = base.where(*conditions), count_base.where(*conditions)

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
    await require_subject_scope(db, _admin, subject_id)
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
    validate_subject_metadata_size(payload.data)
    subject_id = str(uuid.uuid4())
    actor_zones = await admin_zone_ids(db, actor) if has_admin_role(actor) else ()
    incoming = _validated_metadata(payload, known_zone_ids=actor_zones or None)
    barcode = payload.barcode.strip()
    requested_zones = incoming.get("allowedZones")
    if not isinstance(requested_zones, list):
        requested_zones = [incoming["allowedZone"]] if isinstance(incoming.get("allowedZone"), str) else []
    if payload.kind == "hardware" and incoming.get("status", "active") not in {"active", "restricted", "maintenance"}:
        raise HTTPException(422, "Unsupported hardware status")
    if payload.kind == "hardware":
        owner_id, owner_name = await _hardware_employee(db, incoming.get("ownerId"), "owner")
        if has_admin_role(actor):
            await require_subject_scope(db, actor, owner_id)
        incoming["ownerId"] = owner_id
        incoming["owner"] = owner_name
        incoming["assignedEmployeeId"] = owner_id
        incoming["assignedEmployeeName"] = owner_name
        if not incoming.get("category"):
            raise HTTPException(status_code=422, detail="Hardware category is required")
    if payload.kind == "employee" and incoming.get("status", "active") not in {"active", "inactive"}:
        raise HTTPException(422, "Unsupported employee status")
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
        default_checkpoint = f"{actor_zones[0]}-1" if actor_zones else None
        checkpoint_id = await require_registered_checkpoint(db, incoming.get("checkpointId") or default_checkpoint)
        if not has_admin_role(actor):
            checkpoint_id = await require_checkpoint(db, browser_identity(actor), checkpoint_id)
        else:
            visitor_checkpoint = await require_checkpoint_scope(db, actor, checkpoint_id)
        with db.no_autoflush:
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
    if payload.kind == "visitor" and visitor_checkpoint:
        requested_zones = [visitor_checkpoint.zone_id]
    elif has_admin_role(actor):
        if not requested_zones:
            if len(actor_zones) == 1:
                requested_zones = [actor_zones[0]]
            else:
                raise HTTPException(422, "Choose at least one zone for this registry record")
        requested_zones = validate_zone_subset(
            await validate_registered_zones(db, requested_zones), actor_zones)
    else:
        requested_zones = []
    if payload.kind == "visitor":
        incoming["validFrom"] = valid_from
        incoming["validTo"] = valid_to
    data = {
        **incoming,
        # Server-owned fields must be applied last. Operators cannot create an
        # already-approved visitor or smuggle a different identity into the
        # registry payload.
        "status": "pending_approval" if payload.kind == "visitor" else incoming.get("status", "active") if payload.kind in {"employee", "hardware"} else "active",
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
    validate_subject_metadata_size(data)
    new_sub = Subject(id=subject_id, kind=payload.kind, barcode=barcode)
    
    if payload.kind in ("employee", "visitor"):
        new_sub.person = Person(data=data)
    elif payload.kind == "hardware":
        new_sub.hardware = HardwareAsset(data=data)

    db.add(new_sub)
    if payload.kind in {"employee", "visitor", "hardware"}:
        permission_id = str(uuid.uuid4())
        initial_permission = AccessPermission(
            id=permission_id,
            subject_id=subject_id,
            data={
                "id": permission_id,
                "subjectId": subject_id,
                "subjectName": data.get("name") or barcode,
                "subjectType": payload.kind,
                "assignment": "Temporary visitor" if payload.kind == "visitor" else payload.kind.title(),
                "state": "pending_approval" if payload.kind == "visitor" else "active" if data["status"] == "active" else "revoked" if payload.kind == "employee" and data["status"] == "inactive" else "restricted",
                "zones": data.get("allowedZones") or [],
                "validFrom": data.get("validFrom") or "",
                "validTo": data.get("validTo") or data.get("validUntil") or "",
                "source": "request" if payload.kind == "visitor" else "policy",
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "updatedBy": actor.get("sub", "Terminal Operator"),
            },
        )
        db.add(initial_permission)
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
            "permissionVersion": permission_version(initial_permission),
            "createdAt": now.isoformat(),
        }
        db.add(PermissionRequestModel(id=request_id, subject_id=subject_id, data=visitor_request, created_at=now))

    response = SubjectResponse(id=new_sub.id, barcode=new_sub.barcode, kind=new_sub.kind,
        data=data, request=visitor_request)
    try:
        # Approval rows reference the identity by ID rather than through an
        # ORM relationship. Flush the parent within the same transaction first.
        await db.flush([new_sub])
        if visitor_request:
            await enqueue_workflow_start(db, request_id, visitor=True)
            await enqueue_decision(db, {"request": visitor_request, "person": data})
        else:
            await enqueue_changed(db)
        await db.commit()
        await db.refresh(new_sub)
    except HTTPException:
        await db.rollback()
        raise
    except exc.IntegrityError as error:
        await db.rollback()
        if _is_barcode_conflict(error):
            raise HTTPException(status_code=409, detail="This barcode is already registered")
        logger.error("Registry integrity error while creating subject",
            extra={"exception_type": type(error).__name__})
        raise HTTPException(status_code=500, detail="Unable to register subject")
    except Exception as error:
        await db.rollback()
        logger.error("Error creating subject", extra={"exception_type": type(error).__name__})
        raise HTTPException(status_code=500, detail="Internal server error")

    return SubjectResponse(id=new_sub.id, barcode=new_sub.barcode, kind=new_sub.kind, data=data, request=visitor_request)


@router.put("/{subject_id}", response_model=SubjectResponse)
async def update_subject(
    subject_id: str,
    payload: SubjectUpdate,
    db: AsyncSession = Depends(get_db),
    _admin: dict = Depends(verify_admin_request),
) -> SubjectResponse:
    """Update a subject's barcode and/or JSON metadata."""
    await require_subject_scope(db, _admin, subject_id)
    actor_zones = await admin_zone_ids(db, _admin)
    if payload.data is not None:
        validate_subject_metadata_size(payload.data)
    stmt = (
        select(Subject)
        .options(selectinload(Subject.person), selectinload(Subject.hardware))
        .where(Subject.id == subject_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    result = await db.execute(stmt)
    sub = result.scalar_one_or_none()

    if not sub:
        raise HTTPException(status_code=404, detail="Subject not found")

    patch = {key: value for key, value in (payload.data or {}).items()
             if key not in {"id", "type", "kind", "barcode", "inside", "entryOverride", "entryRestriction", "accessRevision", "createdAt"}}
    patch = current_subject_metadata(sub.kind, patch)
    if sub.kind == "hardware":
        current_hardware = (sub.hardware.data if sub.hardware else {}) or {}
        for id_field, name_field, role in (("ownerId", "owner", "owner"),
                                          ("assignedEmployeeId", "assignedEmployeeName", "custodian")):
            if id_field in patch or name_field in patch:
                employee_id, employee_name = await _hardware_employee(
                    db, patch.get(id_field, current_hardware.get(id_field)), role)
                await require_subject_scope(db, _admin, employee_id)
                patch[id_field], patch[name_field] = employee_id, employee_name
    if "allowedZone" in patch:
        zones = await validate_registered_zones(db, [patch["allowedZone"]])
        validate_zone_subset(zones, actor_zones)
        patch["allowedZone"] = zones[0] if len(zones) == 1 else "All Zones"
        patch.setdefault("allowedZones", zones)
    if "allowedZones" in patch:
        patch["allowedZones"] = validate_zone_subset(
            await validate_registered_zones(db, patch["allowedZones"]), actor_zones)
    if "status" in patch:
        statuses = {"active", "restricted", "maintenance"} if sub.kind == "hardware" else {"active", "inactive", "pre_approved", "pending_approval", "restricted", "expired"}
        if patch["status"] not in statuses:
            raise HTTPException(422, "Unsupported registry status")
    for field, limit in _METADATA_LIMITS.items():
        if field in patch and (not isinstance(patch[field], str) or not patch[field].strip() or len(patch[field]) > limit):
            raise HTTPException(422, f"{field} must be non-empty text of at most {limit} characters")

    metadata = sub.hardware if sub.kind == "hardware" else sub.person
    current_data = dict(metadata.data or {}) if metadata else {}
    if payload.data is not None:
        current_data = {**current_data, **patch}
    barcode = payload.barcode if payload.barcode is not None else sub.barcode
    current_data = {**current_subject_metadata(sub.kind, current_data), "id": sub.id, "barcode": barcode, "type": sub.kind}
    validate_window(current_data.get("validFrom"), current_data.get("validTo"))
    if "validFrom" in patch or "validTo" in patch:
        validate_permission_window(current_data.get("validFrom"), current_data.get("validTo"),
            allow_past_start="validFrom" not in patch)
    validate_subject_metadata_size(current_data)
    previous_metadata = dict(metadata.data or {}) if metadata else {}
    current_data = revised_access_data(previous_metadata, current_data,
        force=barcode.casefold() != sub.barcode.casefold())
    validate_subject_metadata_size(current_data)
    # Validate the merged document, including server fields, before changing
    # barcode, ORM metadata, or access permission state in this transaction.
    if payload.barcode is not None:
        sub.barcode = barcode
    if metadata is None and payload.data is not None:
        if sub.kind in ("employee", "visitor"):
            sub.person = metadata = Person(data={})
        elif sub.kind == "hardware":
            sub.hardware = metadata = HardwareAsset(data={})
    if metadata:
        metadata.data = current_data
    # Flush barcode and metadata together inside the conflict handler below.
    permission = await db.scalar(select(AccessPermission).where(AccessPermission.subject_id == sub.id)
        .execution_options(autoflush=False))
    if permission:
        permission_data = {**permission.data, "subjectName": current_data.get("name", sub.barcode),
            "updatedAt": datetime.now(timezone.utc).isoformat(), "updatedBy": _admin.get("sub", "unknown")}
        for source, target in (("allowedZones", "zones"), ("validFrom", "validFrom"), ("validTo", "validTo")):
            if source in patch:
                permission_data[target] = patch[source]
        if "status" in patch:
            permission_data["state"] = {"pre_approved": "active", "inactive": "revoked", "maintenance": "restricted"}.get(patch["status"], patch["status"])
        permission.data = revised_access_data(permission.data, permission_data, permission=True)
    try:
        await enqueue_changed(db)
        await db.commit()
    except HTTPException:
        await db.rollback()
        raise
    except exc.IntegrityError as error:
        await db.rollback()
        if _is_barcode_conflict(error):
            raise HTTPException(status_code=409, detail="This barcode is already registered")
        logger.error("Registry integrity error while updating subject",
            extra={"exception_type": type(error).__name__})
        raise HTTPException(status_code=500, detail="Unable to update subject")
    except Exception as error:
        await db.rollback()
        logger.error("Error updating subject", extra={"exception_type": type(error).__name__})
        raise HTTPException(status_code=500, detail="Internal server error")

    return SubjectResponse(id=sub.id, barcode=sub.barcode, kind=sub.kind, data=current_data)


@router.delete("/{subject_id}", status_code=204)
async def delete_subject(
    subject_id: str,
    db: AsyncSession = Depends(get_db),
    _admin: dict = Depends(verify_admin_request),
):
    """Delete a subject. Postgres CASCADE will remove person/hardware associations."""
    await require_subject_scope(db, _admin, subject_id)
    stmt = select(Subject).where(Subject.id == subject_id).with_for_update()
    result = await db.execute(stmt)
    sub = result.scalar_one_or_none()

    if not sub:
        raise HTTPException(status_code=404, detail="Subject not found")

    # A carried asset is recorded on its carrier's scan, so no direct subject
    # FK protects that hardware. Share the scan's subject lock before checking
    # JSON references to avoid deleting an asset during its admission.
    if sub.kind == "hardware" and await db.scalar(select(Movement.id).where(
            Movement.data["hardwareIds"].contains([subject_id])).limit(1)):
        raise HTTPException(status_code=409,
            detail="Subject has recorded history; restrict access instead of deleting it")

    try:
        # Let database cascades remove metadata/presence while history FKs
        # protect subjects that have already participated in a scan/review.
        await db.execute(delete(Subject).where(Subject.id == subject_id))
        await enqueue_changed(db)
        await db.commit()
    except exc.IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Subject has recorded history; restrict access instead of deleting it")
    except Exception as error:
        await db.rollback()
        logger.error("Error deleting subject", extra={"exception_type": type(error).__name__})
        raise HTTPException(status_code=500, detail="Internal server error")


@bundle_router.get("/bundle")
async def registry_bundle(
    db: AsyncSession = Depends(get_read_db),
    kind: Optional[str] = Query(None, pattern="^(employee|visitor|hardware)$"),
    subjectId: Optional[str] = Query(None, min_length=1, max_length=200),
    limit: int = Query(25, ge=1, le=200),
    offset: int = Query(0, ge=0),
    search: Optional[str] = Query(None, max_length=200),
    days: int = Query(1, ge=1, le=365),
    sortKey: str = Query("name", pattern="^(name|createdAt|barcode|status|inside|owner|category|company|host|validTo|latestScan|averageHours)$"),
    sortDirection: str = Query("asc", pattern="^(asc|desc)$"),
    includeOverview: bool = Query(True),
    actor: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    """Return the complete registry read model in one admin request."""
    zone_ids = await admin_zone_ids(db, actor)
    from event_outbox import read_event_revision
    event_revision = await read_event_revision(db)
    if isinstance(subjectId, str) and subjectId:
        await require_subject_scope(db, actor, subjectId)
        from registry_reads import subject_profile
        return {**await subject_profile(db, subjectId), "eventRevision": event_revision}
    if isinstance(kind, str) and kind:
        from registry_reads import registry_page
        return {**await registry_page(db, kind=kind, limit=limit, offset=offset, search=search,
            days=days, sort_key=sortKey, sort_direction=sortDirection, include_overview=includeOverview,
            zone_ids=zone_ids),
            "eventRevision": event_revision}
    subjects = [row[0] for row in await bounded_rows(db,
        select(Subject).options(
            selectinload(Subject.person),
            selectinload(Subject.hardware),
            selectinload(Subject.presence_state),
        ).outerjoin(Person, Person.subject_id == Subject.id)
        .outerjoin(HardwareAsset, HardwareAsset.subject_id == Subject.id)
        .outerjoin(AccessPermission, AccessPermission.subject_id == Subject.id)
        .where(subject_zone_condition(zone_ids)).order_by(Subject.id)
    )]
    visible_subject_ids = [subject.id for subject in subjects]
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
    permissions = [row[0].data for row in await bounded_rows(db,
        select(AccessPermission).where(AccessPermission.subject_id.in_(visible_subject_ids))
        .order_by(AccessPermission.id)
    )]
    excluded_alert = or_(
        (Alert.data["manualReview"].astext == "true")
        | (Alert.data["ruleId"].astext == "rule-manual-review")
        | (Alert.data["ruleId"].astext == "rule-unknown-barcode")
        | Alert.data["title"].astext.ilike("Unknown barcode%")
    )
    unscoped_alert = and_(
        Alert.data["zoneId"].astext.is_(None),
        Alert.data["checkpointId"].astext.is_(None),
        Alert.data["subjectId"].astext.is_(None),
    )
    alerts = [alert.data for alert in (await db.execute(
        select(Alert)
        .where(~func.coalesce(excluded_alert, False), or_(
            Alert.data["zoneId"].astext.in_(zone_ids),
            Alert.data["checkpointId"].astext.in_(select(Checkpoint.id).where(Checkpoint.zone_id.in_(zone_ids))),
            Alert.data["subjectId"].astext.in_(visible_subject_ids) if visible_subject_ids else false(),
        ))
        .order_by(Alert.created_at.desc())
        .limit(200)
    )).scalars().all()]
    movement_rows = (await db.execute(
        select(Movement).where(checkpoint_zone_condition(Movement, zone_ids))
        .order_by(Movement.occurred_at.desc(), Movement.id).limit(1000)
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
        select(AuditEvent).where(or_(
            AuditEvent.data["zoneId"].astext.in_(zone_ids),
            AuditEvent.data["subjectId"].astext.in_(visible_subject_ids) if visible_subject_ids else false(),
            AuditEvent.data["checkpointId"].astext.in_(select(Checkpoint.id).where(Checkpoint.zone_id.in_(zone_ids))),
        )).order_by(AuditEvent.created_at.desc(), AuditEvent.id).limit(500)
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
        "eventRevision": event_revision,
        "people": people,
        "hardwareAssets": hardware,
        "alerts": alerts,
        "permissions": permissions,
        "movements": movements,
        "auditEvents": audit_events,
        "permissionRequests": [row[0].data for row in await bounded_rows(db,
            select(PermissionRequestModel)
            .where(or_(
                PermissionRequestModel.data["requestedZones"].has_any(list(zone_ids)),
                PermissionRequestModel.data["checkpointId"].astext.in_(select(Checkpoint.id).where(Checkpoint.zone_id.in_(zone_ids))),
                PermissionRequestModel.subject_id.in_(visible_subject_ids) if visible_subject_ids else false(),
            ))
            .order_by(PermissionRequestModel.created_at.desc())
        )],
        "checkpoints": [{**(checkpoint.data or {}), "id": checkpoint.id,
            "zoneId": checkpoint.zone_id, "number": checkpoint.number,
            "gateType": checkpoint.gate_type, "required": checkpoint.required,
            "active": checkpoint.active} for checkpoint in (await db.execute(
            select(Checkpoint).where(Checkpoint.active.is_(True), Checkpoint.zone_id.in_(zone_ids))
            .order_by(Checkpoint.zone_id, Checkpoint.number)
        )).scalars().all()],
    }
