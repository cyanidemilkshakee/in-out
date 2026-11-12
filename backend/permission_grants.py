"""Atomic admin grants, using the same effects as approved operator requests."""
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select, case
from sqlalchemy.orm import selectinload

from access_validation import (require_registered_checkpoint, validate_permission_window,
    validate_registered_checkpoints, validate_registered_zones, validate_zones,
    validate_checkpoint_scopes)
from models import Subject, Person, Checkpoint, PermissionRequestModel, AccessPermission, OrganizationZone
from permission_decisions import apply_permission_decision
from schemas import SubjectCreate
from registry_validation import validated_metadata


async def apply_direct_permission(db, payload, actor, *, known_zone_ids=None):
    now = datetime.now(timezone.utc)
    checkpoint_id = await require_registered_checkpoint(db, payload.checkpoint_id)
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
        incoming = validated_metadata(SubjectCreate(kind="visitor", barcode=payload.barcode,
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
    if subject.kind == "visitor" and permanent_access:
        raise HTTPException(422, "Visitor access must have an expiry")
    if kind == "hardware_custody" and (subject.kind != "hardware" or payload.hardware_id not in (None, subject.id)):
        raise HTTPException(422, "Custody permission requires the selected hardware")
    if subject.kind not in {"employee", "visitor", "hardware"}:
        raise HTTPException(422, "Permissions require people or hardware")

    metadata = subject.hardware if subject.kind == "hardware" else subject.person
    subject_data = (metadata.data if metadata else {}) or {}
    current_permission = await db.scalar(select(AccessPermission).where(
        AccessPermission.subject_id == subject.id).with_for_update()) if not payload.new_visitor else None
    zones = []
    requested_checkpoints = []
    data_scopes_requested = None
    valid_from, valid_to = "", ""
    carrier = None
    carrier_name = ""
    if kind == "hardware_custody":
        carrier = await db.get(Subject, payload.carrier_id) if payload.carrier_id else None
        if not carrier or carrier.kind != "employee":
            raise HTTPException(422, "Custody permission requires a registered employee")
        if (subject_data.get("assignedEmployeeId") or subject_data.get("ownerId")) == carrier.id:
            raise HTTPException(422, "This employee already has custody of this asset")
        carrier_data = await db.get(Person, carrier.id)
        carrier_name = (carrier_data.data or {}).get("name", carrier.barcode) if carrier_data else carrier.barcode
    else:
        if kind == "zone_access" and not payload.requested_zones:
            raise HTTPException(422, "Choose the complete resulting zone set")
        submitted_zones = validate_zones(payload.requested_zones or [checkpoint.zone_id], known_zone_ids=known_zone_ids)
        if kind == "zone_access" and known_zone_ids is not None:
            prior_zones = ((current_permission.data or {}).get("zones") if current_permission else None)
            if not isinstance(prior_zones, list):
                prior_zones = subject_data.get("allowedZones") or ([subject_data.get("allowedZone")]
                    if subject_data.get("allowedZone") else [])
            active_zones = await db.scalars(select(OrganizationZone.id).where(OrganizationZone.active.is_(True)))
            prior_zones = list(active_zones.all()) if "All Zones" in prior_zones else prior_zones
            preserved_zones = [zone for zone in prior_zones if zone not in known_zone_ids]
            zones = await validate_registered_zones(db, list(dict.fromkeys([*preserved_zones, *submitted_zones])))
        else:
            zones = submitted_zones
        current_data = (current_permission.data or {}) if current_permission else {}
        existing_checkpoint_scopes = current_data.get("checkpointScopes")
        if kind == "zone_access" and known_zone_ids is not None:
            if isinstance(existing_checkpoint_scopes, dict):
                requested_scopes = {zone_id: scope for zone_id, scope in existing_checkpoint_scopes.items()
                    if zone_id in zones}
            else:
                existing_selectors = current_data.get("checkpoints")
                if not isinstance(existing_selectors, list):
                    existing_selectors = subject_data.get("allowedCheckpoints")
                if isinstance(existing_selectors, list) and existing_selectors:
                    checkpoint_rows = (await db.execute(select(Checkpoint.id, Checkpoint.zone_id).where(
                        Checkpoint.id.in_(existing_selectors), Checkpoint.active.is_(True)))).all()
                    requested_scopes = {zone_id: [] for zone_id in zones}
                    for selected_id, selected_zone in checkpoint_rows:
                        if selected_zone in requested_scopes:
                            requested_scopes[selected_zone].append(selected_id)
                else:
                    requested_scopes = {zone_id: None for zone_id in zones}
            for zone_id in zones:
                requested_scopes.setdefault(zone_id, None)
            if payload.requested_checkpoints:
                selected_for_scopes = await validate_registered_checkpoints(db, payload.requested_checkpoints)
                for zone_id in known_zone_ids:
                    if zone_id in zones:
                        requested_scopes[zone_id] = [item.id for item in selected_for_scopes if item.zone_id == zone_id]
            data_scopes_requested = await validate_checkpoint_scopes(db, requested_scopes, zones)
        if payload.requested_checkpoints:
            selected = await validate_registered_checkpoints(db, payload.requested_checkpoints)
            requested_checkpoints = [item.id for item in selected]
            if kind == "zone_access" and known_zone_ids is not None:
                prior_checkpoints = current_data.get("checkpoints")
                if not isinstance(prior_checkpoints, list):
                    prior_checkpoints = subject_data.get("allowedCheckpoints")
                if isinstance(prior_checkpoints, list) and prior_checkpoints:
                    prior_rows = await db.execute(select(Checkpoint.id, Checkpoint.zone_id).where(
                        Checkpoint.id.in_(prior_checkpoints), Checkpoint.active.is_(True)))
                    preserved_ids = [checkpoint_id for checkpoint_id, zone_id in prior_rows.all()
                        if zone_id not in known_zone_ids]
                    requested_checkpoints = list(dict.fromkeys([*preserved_ids, *requested_checkpoints]))
            if checkpoint.id not in requested_checkpoints:
                raise HTTPException(422, "The primary checkpoint must be included in checkpoint access")
            if kind == "visitor" and requested_checkpoints != [checkpoint.id]:
                raise HTTPException(422, "Visitor access must target the selected checkpoint only")
            checkpoint_zones = list(dict.fromkeys(item.zone_id for item in selected))
            zone_scoped_edit = kind == "zone_access" and known_zone_ids is not None
            if not zone_scoped_edit and set(zones) != set(checkpoint_zones):
                raise HTTPException(422, "Zone scope must match the selected checkpoints")
            if zone_scoped_edit and (
                    not set(checkpoint_zones) <= set(zones) or not set(checkpoint_zones) <= set(known_zone_ids)):
                raise HTTPException(422, "Zone scope must match the selected checkpoints")
            if kind == "visitor" and zones != [checkpoint.zone_id]:
                raise HTTPException(422, "Visitor checkpoint access must use the selected checkpoint's zone")
        valid_from = payload.valid_from or now.isoformat()
        valid_to = "" if permanent_access else payload.valid_to
        validate_permission_window(valid_from, valid_to, now=now, permanent=permanent_access)
        if subject.kind == "visitor" and not valid_to:
            raise HTTPException(422, "Visitor access must have an expiry")

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
    if data_scopes_requested is not None:
        data.pop("requestedCheckpoints", None)
        data["requestedCheckpointScopes"] = data_scopes_requested
    elif requested_checkpoints:
        data["requestedCheckpoints"] = requested_checkpoints
    elif kind in {"visitor", "zone_access"}:
        if kind == "zone_access":
            # A zone-scoped edit that omits checkpoint selectors retains the
            # existing explicit selector instead of silently clearing it.
            previous = (current_permission.data or {}).get("checkpoints") if current_permission else None
            if isinstance(previous, list):
                data["requestedCheckpoints"] = previous
            else:
                data.pop("requestedCheckpoints", None)
        else:
            data.pop("requestedCheckpoints", None)
    if permanent_access:
        data["permanentAccess"] = True
    if carrier:
        data.update(hardwareId=subject.id, carrierId=carrier.id, carrierName=carrier_name,
            previousCarrierId=subject_data.get("assignedEmployeeId") or subject_data.get("ownerId") or "",
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
        permission = await db.scalar(select(AccessPermission).where(AccessPermission.subject_id == subject.id))
        permission.data = {**permission.data, "source": "manual"}
        result["permission"] = permission.data
    return result, signal_visitor
