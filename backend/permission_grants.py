"""Atomic admin grants, using the same effects as approved operator requests."""
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select, case
from sqlalchemy.orm import selectinload

from access_validation import validate_checkpoint_id, validate_permission_window, validate_zones
from models import Subject, Person, Checkpoint, PermissionRequestModel
from permission_decisions import apply_permission_decision
from schemas import SubjectCreate


async def apply_direct_permission(db, payload, actor):
    now = datetime.now(timezone.utc)
    checkpoint_id = validate_checkpoint_id(payload.checkpoint_id)
    checkpoint = await db.get(Checkpoint, checkpoint_id)
    if not checkpoint:
        raise HTTPException(422, "Checkpoint not registered")

    kind = payload.request_type
    permanent_access = payload.permanent_access
    if permanent_access and kind != "zone_access":
        raise HTTPException(422, "Permanent access is available only for zone access")
    existing = None
    if payload.new_visitor:
        if kind != "visitor" or payload.subject_id or not payload.barcode:
            raise HTTPException(422, "New visitor permissions require a barcode and no existing subject")
        # Registry validation is shared; the subject, grant and history commit together.
        from routers.registry import _validated_metadata
        incoming = _validated_metadata(SubjectCreate(kind="visitor", barcode=payload.barcode,
            data=payload.new_visitor.model_dump(exclude_none=True)))
        subject = Subject(id=str(uuid.uuid4()), barcode=payload.barcode, kind="visitor")
        subject.person = Person(data={**incoming, "id": subject.id, "barcode": subject.barcode,
            "type": "visitor", "status": "pending_approval", "inside": False,
            "allowedZones": [], "purpose": payload.reason,
            "createdAt": now.isoformat()})
        db.add(subject)
    else:
        if not payload.subject_id:
            raise HTTPException(422, "Choose a registered subject")
        # Requests created while we wait for this lock must be seen by the grant.
        subject = await db.scalar(select(Subject).where(Subject.id == payload.subject_id)
            .options(selectinload(Subject.person), selectinload(Subject.hardware)).with_for_update())
        if not subject:
            raise HTTPException(404, "Subject not found")
        request_types = [kind]
        if subject.kind == "visitor" and kind == "zone_access":
            request_types.append("visitor")
        pending = select(PermissionRequestModel).where(
            PermissionRequestModel.subject_id == payload.subject_id,
            PermissionRequestModel.data["status"].astext == "pending",
            PermissionRequestModel.data["type"].astext.in_(request_types),
        )
        if kind == "hardware_custody":
            pending = pending.where(PermissionRequestModel.data["carrierId"].astext == payload.carrier_id)
        # A decision can own the request while waiting for our subject lock.
        # Fail with a retryable conflict rather than deadlocking that decision.
        existing = await db.scalar(pending.order_by(
            case((PermissionRequestModel.data["type"].astext == "visitor", 0), else_=1),
            PermissionRequestModel.created_at,
        ).limit(1).with_for_update(nowait=True))

    if kind == "visitor" and subject.kind != "visitor":
        raise HTTPException(422, "Visitor permissions require a visitor")
    if kind == "hardware_custody" and (subject.kind != "hardware" or payload.hardware_id not in (None, subject.id)):
        raise HTTPException(422, "Custody permission requires the selected hardware")
    if subject.kind not in {"employee", "visitor", "hardware"}:
        raise HTTPException(422, "Permissions require people or hardware")

    metadata = subject.hardware if subject.kind == "hardware" else subject.person
    subject_data = (metadata.data if metadata else {}) or {}
    zones = []
    valid_from, valid_to = "", ""
    carrier = None
    carrier_name = ""
    if kind == "hardware_custody":
        carrier = await db.get(Subject, payload.carrier_id) if payload.carrier_id else None
        if not carrier or carrier.kind != "employee":
            raise HTTPException(422, "Custody permission requires a registered employee")
        if subject_data.get("assignedEmployeeId") == carrier.id:
            raise HTTPException(422, "This employee already has custody of this asset")
        carrier_data = await db.get(Person, carrier.id)
        carrier_name = (carrier_data.data or {}).get("name", carrier.barcode) if carrier_data else carrier.barcode
    else:
        if kind == "zone_access" and not payload.requested_zones:
            raise HTTPException(422, "Choose the complete resulting zone set")
        zones = validate_zones(payload.requested_zones or [checkpoint.data.get("zone", "public")])
        valid_from = payload.valid_from or now.isoformat()
        valid_to = "" if permanent_access else payload.valid_to
        validate_permission_window(valid_from, valid_to, now=now, permanent=permanent_access)

    if payload.new_visitor:
        # Separate ORM mappers have no request→subject relationship to order these inserts.
        # This flush stays in the grant transaction, so later effect failures roll it back.
        await db.flush()
    req_id = existing.id if existing else f"REQ-{uuid.uuid4().hex[:12].upper()}"
    signal_visitor = bool(existing and (existing.data or {}).get("type") == "visitor")
    decision_kind = "visitor" if signal_visitor else kind
    data = {**(existing.data if existing else {}), "id": req_id, "subjectId": subject.id,
        "subjectName": subject_data.get("name") or subject.barcode, "subjectType": subject.kind,
        "barcode": subject.barcode, "type": decision_kind, "purpose": payload.reason,
        "checkpointId": checkpoint.id, "checkpoint": checkpoint.data.get("name", checkpoint.id),
        "requester": (existing.data or {}).get("requester") if existing else actor,
        "requestedZones": zones, "validFrom": valid_from, "validTo": valid_to,
        "status": "pending", "createdAt": (existing.data or {}).get("createdAt") if existing else now.isoformat(),
        "origin": "permission_manager"}
    if permanent_access:
        data["permanentAccess"] = True
    if carrier:
        data.update(hardwareId=subject.id, carrierId=carrier.id, carrierName=carrier_name,
            previousCarrierId=subject_data.get("assignedEmployeeId") or "",
            previousCarrierName=subject_data.get("assignedEmployeeName") or "Unassigned")
    if kind == "zone_access":
        data.update(previousZones=subject_data.get("allowedZones") or [],
            previousValidFrom=subject_data.get("validFrom") or "", previousValidTo=subject_data.get("validTo") or "")
    if existing:
        existing.data = data
    else:
        db.add(PermissionRequestModel(id=req_id, subject_id=subject.id, data=data, created_at=now))
    await db.flush()
    result = await apply_permission_decision(db, req_id, "approved", actor, payload.reason)
    # These are direct admin permissions; no pending approval or workflow is exposed.
    if result.get("permission"):
        from models import AccessPermission
        permission = await db.scalar(select(AccessPermission).where(AccessPermission.subject_id == subject.id))
        permission.data = {**permission.data, "source": "manual"}
        result["permission"] = permission.data
    return result, signal_visitor
