"""Atomic permission decisions shared by HTTP requests and retryable activities."""
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import select, func
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import selectinload

from models import (Subject, Person, HardwareAsset, AccessPermission, PresenceState,
                    PermissionRequestModel, Movement, Checkpoint, AuditEvent)
from redis_client import publish_presence_update
from movement_logic import _current_date, _current_time
from access_validation import validate_permission_window, validate_zones, validate_checkpoint_id
from facility_zones import building_for_checkpoint, canonical_checkpoint_id, normalize_facility_document
from schemas import manual_approval_minutes
from critical_entry_restrictions import (
    entry_restrictions_for_subjects,
    ensure_legacy_warning_threshold_restrictions,
)
from subject_metadata import current_subject_metadata

logger = logging.getLogger(__name__)


async def review_source(db, event_id, barcode, checkpoint_id, direction=None):
    checkpoint_id = validate_checkpoint_id(checkpoint_id)
    if not event_id:
        return None
    source = await db.get(Movement, event_id)
    if (not source or source.result != "denied" or canonical_checkpoint_id(source.checkpoint_id) != checkpoint_id or
        str(source.data.get("barcode", "")).casefold() != barcode.casefold() or
        (direction and source.direction != direction)):
        raise HTTPException(422, "Manual review must match a denied scan at this checkpoint")
    return source


async def pending_manual_review(db, barcode, checkpoint_id, direction):
    checkpoint_id = validate_checkpoint_id(checkpoint_id)
    key = f"review:{barcode.lower()}:{checkpoint_id}:{direction}"
    await db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended(key, 0))))
    return await db.scalar(select(PermissionRequestModel).where(
        PermissionRequestModel.data["type"].astext == "manual_override",
        PermissionRequestModel.data["status"].astext == "pending",
        func.lower(PermissionRequestModel.data["barcode"].astext) == barcode.lower(),
        PermissionRequestModel.data["checkpointId"].astext.in_(
            ["cp-main", "main-gate"] if checkpoint_id == "cp-main" else [checkpoint_id]),
        PermissionRequestModel.data["direction"].astext == direction,
    ).order_by(PermissionRequestModel.created_at).limit(1))


async def ensure_review_subject(db, data):
    """Give an approved unknown barcode an identity without granting future entry."""
    barcode = str(data.get("barcode") or "").strip()
    if not barcode:
        raise HTTPException(422, "The manual review has no barcode")
    # Same key for different requests reviewing the same case-insensitive barcode.
    await db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended("barcode:" + barcode.lower(), 0))))
    subject = await db.scalar(select(Subject).where(func.lower(Subject.barcode) == barcode.lower()))
    if subject:
        return subject
    subject_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    person_data = {
        "id": subject_id, "name": data.get("subjectName") or "Manually admitted visitor",
        "type": "visitor", "barcode": barcode, "status": "pending_approval", "inside": False,
        "allowedZones": validate_zones(data.get("requestedZones") or []), "createdAt": now,
        "purpose": data.get("purpose") or "Manual review", "host": "Security",
        "company": "", "phone": "",
    }
    subject = Subject(id=subject_id, barcode=barcode, kind="visitor", person=Person(data=person_data))
    db.add(subject)
    await db.flush()
    permission_id = str(uuid.uuid4())
    db.add(AccessPermission(id=permission_id, subject_id=subject_id, data={
        "id": permission_id, "subjectId": subject_id, "subjectName": person_data["name"],
        "subjectType": "visitor", "state": "pending_approval", "zones": person_data["allowedZones"],
        "reason": "Manual approval covers one entry and its exit; future entry requires approval.",
        "updatedAt": now, "updatedBy": "manual-review", "assignment": "One visit",
        "source": "request", "validFrom": "", "validTo": "",
    }))
    await db.flush()
    return subject


async def _manual_movement(db, req, decision, actor, reason, now):
    data = normalize_facility_document(dict(req.data))
    data["checkpointId"] = validate_checkpoint_id(data.get("checkpointId"))
    req.data = data
    subject_id = req.subject_id
    if decision == "approved" and not subject_id:
        subject = await ensure_review_subject(db, data)
        subject_id = subject.id
        req.subject_id = subject_id
        data.update(subjectId=subject_id, subjectType=subject.kind, barcode=subject.barcode)
        req.data = data
    source = await review_source(db, data.get("eventId"), data.get("barcode", ""), data.get("checkpointId"), data.get("direction"))
    hardware_ids = list(dict.fromkeys(source.data.get("hardwareIds") or [])) if source else []
    ids = sorted(set(([subject_id] if subject_id else []) + hardware_ids))
    subjects = list((await db.scalars(select(Subject).where(Subject.id.in_(ids))
        .order_by(Subject.id).with_for_update()
        .options(selectinload(Subject.person), selectinload(Subject.hardware)))).all())
    subject = next((item for item in subjects if item.id == subject_id), None)
    if subject_id and not subject:
        raise HTTPException(422, "Review subject no longer exists")
    if not set(hardware_ids).issubset({item.id for item in subjects if item.kind == "hardware"}):
        raise HTTPException(422, "Reviewed hardware no longer exists")
    checkpoint = await db.get(Checkpoint, data.get("checkpointId"))
    if not checkpoint:
        raise HTTPException(422, "Checkpoint not registered")
    states = {}
    if decision == "approved":
        for item in subjects:
            await db.execute(insert(PresenceState).values(subject_id=item.id, state="outside")
                .on_conflict_do_nothing(index_elements=["subject_id"]))
            state = await db.scalar(select(PresenceState).where(PresenceState.subject_id == item.id).with_for_update())
            if source and state.last_scan_timestamp and state.last_scan_timestamp > source.occurred_at:
                raise HTTPException(409, "A newer approved scan exists; scan again before requesting review")
            states[item.id] = state
    current = states.get(subject_id)
    direction = data.get("direction") or (source.direction if source else None)
    if direction not in {"entry", "exit"}:
        direction = "exit" if current and current.state == "inside" else "entry"
    if decision == "approved" and direction == "entry":
        await ensure_legacy_warning_threshold_restrictions(db, ids)
        active_restrictions = await entry_restrictions_for_subjects(db, ids, active_only=True)
        if active_restrictions:
            raise HTTPException(
                409,
                "An entry restriction is active; an administrator must lift it before approving entry",
            )
    for item in subjects if decision == "approved" else []:
        state = states[item.id]
        state.state = "inside" if direction == "entry" else "outside"
        state.last_scan_timestamp = now
        state.entry_override = (
            {"requestId": req.id, "hardwareIds": hardware_ids, "validTo": data.get("validTo")}
            if direction == "entry" else None
        )
        metadata = item.hardware if item.kind == "hardware" else item.person
        if metadata is None:
            raise HTTPException(422, "Subject metadata is missing")
        metadata.data = {**current_subject_metadata(item.kind, metadata.data), "id": item.id, "barcode": item.barcode, "inside": direction == "entry"}
    if source:
        # A manual review completes the original scan; it is not another scan.
        # Preserve the original event ID and timestamp so dashboards and the
        # movement ledger count one access attempt with its final outcome.
        event = {
            **source.data,
            "id": source.id,
            "checkpointId": checkpoint.id,
            "checkpoint": checkpoint.data.get("name", checkpoint.id),
            "direction": direction,
            "subjectId": subject_id or source.data.get("subjectId", "unregistered"),
            "subjectName": data.get("subjectName") or source.data.get("subjectName") or data.get("barcode", "Unknown"),
            "subjectType": subject.kind if subject else source.subject_type,
            "barcode": subject.barcode if subject else data.get("barcode", source.data.get("barcode", "")),
            "result": decision,
            "scanType": "manual",
            "reason": reason,
            "hardwareIds": hardware_ids,
            "overrideRequestId": req.id,
            "adminId": actor,
            "manualReviewedAt": now.isoformat(),
            "initialResult": source.data.get("initialResult", source.result),
            "initialScanType": source.data.get("initialScanType", source.scan_type),
            "initialReason": source.data.get("initialReason", source.data.get("reason")),
        }
        if decision == "denied":
            event["denialCode"] = "manual_review"
        else:
            event.pop("denialCode", None)
        source.subject_id = subject_id
        source.checkpoint_id = checkpoint.id
        source.result = decision
        source.scan_type = "manual"
        source.direction = direction
        source.subject_type = event["subjectType"]
        source.denial_code = event.get("denialCode")
        source.data = event
        return event, subjects

    # Older records may not carry an originating scan. Those manual decisions
    # remain their own movement because there is no scan to finalize.
    event_id = "MAN-" + uuid.uuid4().hex
    event = {
        "id": event_id, "date": _current_date(now), "time": _current_time(now),
        "checkpointId": checkpoint.id, "checkpoint": checkpoint.data.get("name", checkpoint.id),
        "direction": direction, "subjectId": subject_id or "unregistered",
        "subjectName": data.get("subjectName") or data.get("barcode", "Unknown"),
        "subjectType": subject.kind if subject else data.get("subjectType", "visitor"),
        "barcode": subject.barcode if subject else data.get("barcode", ""),
        "result": decision, "reason": reason, "scanType": "manual", "syncState": "synced",
        "hardwareIds": hardware_ids, "createdAt": now.isoformat(),
        "overrideRequestId": req.id, "adminId": actor,
    }
    if decision == "denied":
        event["denialCode"] = "manual_review"
    db.add(Movement(id=event_id, subject_id=subject_id, checkpoint_id=checkpoint.id,
        occurred_at=now, result=decision, direction=direction, scan_type="manual",
        sync_state="synced", subject_type=event["subjectType"],
        denial_code=event.get("denialCode"), data=event))
    return event, subjects


async def _prepare_manual_approval_subject(db, req, data):
    """Ensure the approved barcode has an identity, without admitting it yet."""
    data = normalize_facility_document(data)
    data["checkpointId"] = validate_checkpoint_id(data.get("checkpointId"))
    source = await review_source(
        db, data.get("eventId"), data.get("barcode", ""), data["checkpointId"], data.get("direction")
    )
    if source and (source.denial_code or source.data.get("denialCode")) == "cross_building_access":
        raise HTTPException(
            409,
            "This scan crossed zone boundaries. The subject must exit the zone where they are recorded before scanning here.",
        )
    direction = data.get("direction") or (source.direction if source else None)
    if direction not in {"entry", "exit"}:
        raise HTTPException(422, "Manual approval must specify an entry or exit direction")
    data["direction"] = direction
    checkpoint = await db.get(Checkpoint, data["checkpointId"])
    if not checkpoint:
        raise HTTPException(422, "Checkpoint not registered")

    if not req.subject_id:
        subject = await ensure_review_subject(db, data)
        req.subject_id = subject.id
    subject_ids = sorted(set([req.subject_id, *((source.data.get("hardwareIds") or []) if source else [])]))
    subjects = list((await db.scalars(select(Subject).where(Subject.id.in_(subject_ids))
        .order_by(Subject.id)
        .with_for_update()
        .options(selectinload(Subject.person), selectinload(Subject.hardware)))).all())
    subject = next((item for item in subjects if item.id == req.subject_id), None)
    if not subject:
        raise HTTPException(422, "Review subject no longer exists")
    if source and source.subject_id and source.subject_id != subject.id:
        raise HTTPException(422, "Manual approval subject does not match the denied scan")
    expected_hardware = set(source.data.get("hardwareIds") or []) if source else set()
    if not expected_hardware.issubset({item.id for item in subjects if item.kind == "hardware"}):
        raise HTTPException(422, "Reviewed hardware no longer exists")
    if subject.kind == "hardware" and not subject.hardware or subject.kind != "hardware" and not subject.person:
        raise HTTPException(422, "Subject metadata is missing")
    building_id = building_for_checkpoint(data["checkpointId"])
    presence_rows = await db.scalars(select(PresenceState).where(
        PresenceState.subject_id.in_(subject_ids)
    ).order_by(PresenceState.subject_id).with_for_update())
    if any(state.state == "inside" and state.entry_building_id != building_id for state in presence_rows):
        raise HTTPException(
            409,
            "This subject or carried hardware is recorded inside another zone and cannot be approved here.",
        )
    data.update(subjectId=subject.id, subjectType=subject.kind, barcode=subject.barcode)
    req.data = data
    return subject


async def apply_permission_decision(db, request_id, decision, actor, reason, *, valid_for_minutes=None, from_activity=False):
    req = await db.scalar(select(PermissionRequestModel).where(PermissionRequestModel.id == request_id).with_for_update())
    if not req:
        raise HTTPException(404, "Request not found")
    data = dict(req.data)
    kind = data.get("type")
    duration = None
    if kind == "manual_override":
        # Validate before mutations and before the idempotent return, so direct
        # activity calls cannot bypass the same strict choices as the HTTP API.
        try:
            duration = manual_approval_minutes(valid_for_minutes)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
    existing = await db.scalar(select(Movement).where(Movement.data["overrideRequestId"].astext == request_id).limit(1))
    status = data.get("status")
    if status != "pending":
        # Activities and HTTP retries never change an already completed decision.
        if status != decision:
            if from_activity:
                return {"request": data, "movement": existing.data if existing else None}
            raise HTTPException(409, "Permission request has already been decided")
        if data.get("appliedAt") or existing:
            return {"request": data, "movement": existing.data if existing else None}
    if kind not in {"manual_override", "visitor", "zone_access", "hardware_custody"}:
        raise HTTPException(422, "Unsupported permission request type")
    now = datetime.now(timezone.utc)
    if kind == "manual_override" and decision == "approved":
        data["validFrom"] = now.isoformat()
        data["validTo"] = (now + timedelta(minutes=duration)).isoformat()
    req.data = data
    movement = None
    changed_subjects = []
    permission = None
    if kind == "manual_override":
        if decision == "approved":
            # Approval opens a time-limited, one-entry grant. The denied scan
            # remains in the ledger; terminal rescan consumes the grant.
            subject = await _prepare_manual_approval_subject(db, req, data)
            changed_subjects = [subject]
        else:
            movement, changed_subjects = await _manual_movement(db, req, decision, actor, reason, now)
        if req.subject_id:
            perm = await db.scalar(select(AccessPermission).where(AccessPermission.subject_id == req.subject_id))
            permission = perm.data if perm else None
    elif decision == "approved" or kind == "visitor":
        subject = await db.scalar(select(Subject).where(Subject.id == req.subject_id).with_for_update()
            .options(selectinload(Subject.person), selectinload(Subject.hardware)))
        if not subject:
            raise HTTPException(422, "Request subject no longer exists")
        changed_subjects = [subject]
        if kind == "hardware_custody":
            asset_id = data.get("hardwareId") or subject.id
            if subject.kind != "hardware" or asset_id != subject.id:
                raise HTTPException(422, "Custody review subject must be the requested hardware")
            asset = await db.scalar(
                select(HardwareAsset).where(HardwareAsset.subject_id == asset_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
            carrier = await db.get(Subject, data.get("carrierId")) if data.get("carrierId") else None
            if not asset or not carrier or carrier.kind != "employee":
                raise HTTPException(422, "Custody approval requires registered hardware and an employee")
            if (asset.data or {}).get("assignedEmployeeId") == carrier.id:
                raise HTTPException(409, "This employee already has custody of this asset")
            carrier_metadata = await db.get(Person, carrier.id)
            asset.data = {**(asset.data or {}), "assignedEmployeeId": carrier.id, "assignedEmployeeName": carrier_metadata.data.get("name", carrier.barcode) if carrier_metadata else carrier.barcode}
        else:
            perm = await db.scalar(select(AccessPermission).where(AccessPermission.subject_id == subject.id))
            if not perm:
                perm = AccessPermission(id=str(uuid.uuid4()), subject_id=subject.id, data={})
                db.add(perm)
            metadata = subject.hardware if subject.kind == "hardware" else subject.person
            state = "active" if decision == "approved" else "restricted"
            permission = {**perm.data, "id": perm.id, "subjectId": subject.id,
                "subjectType": subject.kind, "subjectName": data.get("subjectName", subject.barcode),
                "state": state, "reason": reason, "updatedAt": now.isoformat(), "updatedBy": actor,
                "assignment": perm.data.get("assignment", subject.kind.title()), "source": "request"}
            if decision == "approved":
                permanent_access = data.get("permanentAccess") is True and data.get("origin") == "permission_manager"
                validate_permission_window(data.get("validFrom"), data.get("validTo"), now=now,
                    allow_past_start=True, permanent=permanent_access)
                zones = validate_zones(data.get("requestedZones") or [])
                req.data = {**req.data, "requestedZones": zones}
                permission.update(zones=zones, validFrom=data.get("validFrom", ""), validTo=data.get("validTo", ""))
            perm.data = permission
            if metadata:
                metadata.data = {**current_subject_metadata(subject.kind, metadata.data), "status": "pre_approved" if subject.kind == "visitor" and decision == "approved" else state,
                    **({"allowedZones": permission["zones"], "validFrom": permission["validFrom"], "validTo": permission["validTo"]} if decision == "approved" else {})}
    req.data = {**req.data, "status": decision, "decidedAt": data.get("decidedAt") or now.isoformat(),
                "decidedBy": data.get("decidedBy") or actor, "decisionReason": reason, "appliedAt": now.isoformat()}
    audit_id = "AUD-" + uuid.uuid4().hex
    audit = {"id": audit_id, "category": "permission", "action": f"{kind.replace('_', ' ').title()} {decision}",
        "subjectId": req.subject_id or "", "subjectName": data.get("subjectName") or "Unregistered barcode",
        "barcode": data.get("barcode") or "", "actor": actor, "role": "Administrator" if actor != "system" else "System",
        "decision": "granted" if decision == "approved" else "denied", "reason": reason,
        "relatedId": req.id, "createdAt": now.isoformat()}
    db.add(AuditEvent(id=audit_id, created_at=now, data=audit))
    await db.flush()
    restrictions = await entry_restrictions_for_subjects(db, [item.id for item in changed_subjects])
    if permission:
        permission = {**permission, "entryRestriction": restrictions.get(req.subject_id)}
    person = next(({**current_subject_metadata(item.kind, item.person.data), "id": item.id, "barcode": item.barcode, "type": item.kind,
                   "entryRestriction": restrictions.get(item.id)}
                   for item in changed_subjects if item.kind != "hardware" and item.person), None)
    hardware = next(({**item.hardware.data, "id": item.id, "barcode": item.barcode,
                     "entryRestriction": restrictions.get(item.id)}
                     for item in changed_subjects if item.kind == "hardware" and item.hardware), None)
    return {"request": req.data, "movement": movement, "auditEvent": audit, "permission": permission,
            "hardwareAssets": [{**item.hardware.data, "id": item.id, "barcode": item.barcode,
                                "entryRestriction": restrictions.get(item.id)}
                               for item in changed_subjects if item.kind == "hardware" and item.hardware],
            "person": person, "hardwareAsset": hardware}


async def publish_decision(result):
    """Live event publication must not undo a committed decision."""
    try:
        await publish_presence_update(json.dumps({
            "type": "manual_review_decision",
            "requestId": result["request"]["id"],
            "subject_id": result["request"].get("subjectId"),
            "movement": result.get("movement"),
            "request": result["request"],
            "permission": result.get("permission"),
            "people": [result["person"]] if result.get("person") else [],
            "hardwareAssets": result.get("hardwareAssets", [result["hardwareAsset"]] if result.get("hardwareAsset") else []),
        }))
    except Exception:
        logger.exception("Permission decision committed; live publication failed")
