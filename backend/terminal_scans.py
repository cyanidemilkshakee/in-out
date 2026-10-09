"""Transactional scan processing shared by browser and certificate terminals."""
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload
from sqlalchemy.dialects.postgresql import insert

from models import Subject, PresenceState, ScanRequest, Movement, Checkpoint, AccessPermission, PermissionRequestModel, Alert as AlertModel
from movement_logic import evaluate_scan, apply_movement_state, _current_date, _current_time
from access_validation import parse_validity, validate_checkpoint_id
from facility_zones import (
    BUILDING_NAMES,
    CHECKPOINTS,
    building_for_checkpoint,
    canonical_checkpoint_id,
    compatible_request_fingerprints,
    normalize_facility_document,
)
from critical_entry_restrictions import (
    entry_restrictions_for_subjects,
    ensure_legacy_warning_threshold_restrictions,
)
from subject_metadata import current_subject_metadata


async def _approved_manual_review(db, barcode, checkpoint_id, direction, hardware_ids, now):
    """Lock and return one unused approval whose entry window is still open."""
    checkpoint_ids = [checkpoint_id]
    if canonical_checkpoint_id(checkpoint_id) == "cp-main":
        checkpoint_ids = ["cp-main", "main-gate"]
    requests = await db.scalars(select(PermissionRequestModel).where(
        PermissionRequestModel.data["type"].astext == "manual_override",
        PermissionRequestModel.data["status"].astext == "approved",
        PermissionRequestModel.data["consumedAt"].astext.is_(None),
        func.lower(PermissionRequestModel.data["barcode"].astext) == barcode.lower(),
        PermissionRequestModel.data["checkpointId"].astext.in_(checkpoint_ids),
        PermissionRequestModel.data["direction"].astext == direction,
    ).order_by(PermissionRequestModel.created_at.desc()).limit(50).with_for_update())

    for request in requests:
        data = request.data or {}
        try:
            valid_from = parse_validity(data.get("validFrom"))
            valid_to = parse_validity(data.get("validTo"))
        except HTTPException:
            continue
        if not valid_from <= now < valid_to:
            continue

        source_event_id = data.get("eventId")
        if source_event_id:
            source = await db.get(Movement, source_event_id)
            if not source:
                continue
            expected_hardware = set(source.data.get("hardwareIds") or [])
        else:
            expected_hardware = set()
        if expected_hardware != set(hardware_ids):
            continue
        return request
    return None


async def record_scan(db, key, payload, terminal_id):
    db.info["scan_replayed"] = False
    db.info["scan_alerts"] = []
    normalized = payload.model_dump(mode="json")
    normalized["barcode"] = payload.barcode.strip().lower()
    normalized["selected_hardware_ids"] = sorted(set(payload.selected_hardware_ids))
    checkpoint_id = validate_checkpoint_id(payload.checkpoint_id)
    fingerprints = compatible_request_fingerprints(normalized, ["checkpoint_id"])
    fingerprint = fingerprints[0]
    # Serialize retries even when a caller reuses a key for a different subject.
    await db.execute(select(func.pg_advisory_xact_lock(key.int % (2**63 - 1))))
    cached = await db.get(ScanRequest, key)
    if cached:
        if cached.terminal_id != terminal_id:
            raise HTTPException(409, "Idempotency key belongs to another terminal")
        if cached.request_fingerprint and cached.request_fingerprint not in fingerprints:
            raise HTTPException(409, "Idempotency key was already used for a different scan")
        response = normalize_facility_document(cached.response_body)
        # Old idempotency snapshots remain evidence, but current person metadata
        # must not resurrect retired employee fields on a replay or live update.
        replay_decision = response.get("decision") or {}
        replay_subject = await db.get(Subject, cached.subject_id) if cached.subject_id else None
        replay_kind = replay_subject.kind if replay_subject else (replay_decision.get("event") or {}).get("subjectType")
        if isinstance(replay_decision.get("subject"), dict):
            replay_decision["subject"] = current_subject_metadata(replay_kind, replay_decision["subject"])
        if "updatedPeople" in response:
            response["updatedPeople"] = [
                current_subject_metadata(replay_kind if person.get("id") == cached.subject_id else person.get("type"), person)
                for person in response["updatedPeople"]
            ]
        event = (response.get("decision") or {}).get("event") or {}
        if response.get("allowed") and event.get("direction") == "entry":
            ids = sorted(set(([cached.subject_id] if cached.subject_id else []) + (event.get("hardwareIds") or [])))
            # A stale online/offline success cannot approve entry after a new
            # entry hold. Use the same subject locks as fresh scan decisions.
            if ids:
                await db.execute(select(Subject.id).where(Subject.id.in_(ids)).order_by(Subject.id).with_for_update())
            await ensure_legacy_warning_threshold_restrictions(db, ids)
            restrictions = await entry_restrictions_for_subjects(db, ids, active_only=True)
            if restrictions:
                raise HTTPException(403, "An entry restriction is active; scan again for administrator review")
        db.info["scan_replayed"] = True
        return response

    subject = (await db.execute(select(Subject).where(
        func.lower(Subject.barcode) == payload.barcode.strip().lower()
    ))).scalar_one_or_none()
    if not subject:
        checkpoint = await db.get(Checkpoint, checkpoint_id)
        if not checkpoint:
            raise HTTPException(422, "Checkpoint not registered")
        now = datetime.now(timezone.utc)
        direction = payload.direction or checkpoint.data.get("mode")
        if direction not in {"entry", "exit"}:
            direction = "entry"
        event = {
            "id": str(uuid.uuid4()), "date": _current_date(now),
            "time": _current_time(now), "checkpointId": checkpoint.id,
            "checkpoint": checkpoint.data.get("name", checkpoint.id), "direction": direction,
            "subjectId": "unregistered", "subjectName": "Unregistered barcode",
            "subjectType": "visitor", "barcode": payload.barcode.strip(), "result": "denied",
            "reason": "Barcode not registered", "denialCode": "barcode_not_registered",
            "scanType": payload.scan_type, "syncState": "synced" if payload.online else "queued",
            "hardwareIds": [], "createdAt": now.isoformat(),
        }
        if payload.captured_offline_at:
            event["capturedOfflineAt"] = payload.captured_offline_at.isoformat()
        decision = {"event": event, "carriedHardware": []}
        db.add(Movement(id=event["id"], subject_id=None, checkpoint_id=checkpoint.id,
            occurred_at=now, result="denied", direction=direction,
            denial_code="barcode_not_registered", scan_type=payload.scan_type,
            subject_type="visitor", sync_state=event["syncState"], data=event))
        await db.flush()
        result = {"allowed": False, "reason": event["reason"], "subject_id": None,
            "decision": decision, "updatedPeople": [], "updatedHardwareAssets": []}
        db.add(ScanRequest(idempotency_key=key, subject_id=None, terminal_id=terminal_id,
            status_code=200, response_body=result, request_fingerprint=fingerprint))
        await db.flush()
        return result
    if subject.kind == "hardware" and payload.selected_hardware_ids:
        raise HTTPException(422, "A hardware scan cannot carry other hardware")
    checkpoint = await db.get(Checkpoint, checkpoint_id)
    if not checkpoint:
        raise HTTPException(422, "Checkpoint not registered")
    ids = sorted(set([subject.id, *payload.selected_hardware_ids]))
    subjects = (await db.execute(select(Subject).where(Subject.id.in_(ids))
        .order_by(Subject.id).with_for_update()
        .options(selectinload(Subject.person), selectinload(Subject.hardware)))).scalars().all()
    assets = {s.id for s in subjects if s.kind == "hardware"}
    if not set(payload.selected_hardware_ids).issubset(assets):
        raise HTTPException(422, "Selected hardware is not registered")
    people, hardware, states = [], [], {}
    permission_result = await db.execute(
        select(AccessPermission).where(AccessPermission.subject_id.in_(ids)).order_by(AccessPermission.id)
    )
    permissions = {}
    for permission in permission_result.scalars().all():
        permissions.setdefault(permission.subject_id, permission.data or {})
    restrictions = await ensure_legacy_warning_threshold_restrictions(db, ids)
    for sub in subjects:
        metadata = sub.hardware if sub.kind == "hardware" else sub.person
        if metadata is None:
            raise HTTPException(422, "Subject metadata is missing")
        data = {**current_subject_metadata(sub.kind, normalize_facility_document(metadata.data)), "id": sub.id, "barcode": sub.barcode}
        # Never trust an editable JSONB metadata field for this server-owned hold.
        data["entryRestriction"] = restrictions.get(sub.id)
        permission = normalize_facility_document(permissions.get(sub.id, {}))
        permission_state = permission.get("state")
        if permission_state:
            if sub.kind == "visitor" and permission_state == "active":
                data["status"] = "pre_approved"
            else:
                status_map = {
                    "active": "active",
                    "restricted": "restricted",
                    "pending_approval": "pending_approval",
                    "expired": "expired",
                    "revoked": "inactive",
                }
                data["status"] = status_map.get(permission_state, data.get("status", "inactive"))
        if isinstance(permission.get("zones"), list):
            data["allowedZones"] = permission["zones"]
        if permission.get("validFrom"):
            data["validFrom"] = permission["validFrom"]
        if permission.get("validTo"):
            data["validTo"] = permission["validTo"]
        if sub.kind != "hardware":
            data["type"] = sub.kind
        else:
            data.setdefault("category", "Hardware")
        await db.execute(insert(PresenceState).values(subject_id=sub.id,
            state="inside" if data.get("inside") else "outside")
            .on_conflict_do_nothing(index_elements=["subject_id"]))
        presence = (await db.execute(select(PresenceState).where(
            PresenceState.subject_id == sub.id).with_for_update())).scalar_one()
        states[sub.id] = presence
        data["inside"] = presence.state == "inside"
        # This entitlement comes only from locked database state, not editable metadata.
        data["entryOverride"] = presence.entry_override
        (hardware if sub.kind == "hardware" else people).append(data)

    cp = {**checkpoint.data, **next(cp for cp in CHECKPOINTS if cp["id"] == checkpoint.id)}
    if payload.direction:
        cp["mode"] = payload.direction
    building_id = cp.get("buildingId") or building_for_checkpoint(checkpoint.id)
    subjects_by_id = {data["id"]: data for data in [*people, *hardware]}
    location_conflict = next((
        (sub, states[sub.id].entry_building_id)
        for sub in [subject, *(item for item in subjects if item.id != subject.id)]
        if states[sub.id].state == "inside" and states[sub.id].entry_building_id != building_id
    ), None)
    decision = evaluate_scan(barcode=payload.barcode, checkpoint=cp, people=people,
        hardware=hardware, selected_hardware_ids=payload.selected_hardware_ids,
        online=payload.online, event_count=0, scan_type=payload.scan_type,
        event_id=str(uuid.uuid4()))
    event = decision["event"]
    if payload.captured_offline_at:
        event["capturedOfflineAt"] = payload.captured_offline_at.isoformat()
    now = datetime.now(timezone.utc)
    last_scan = states[subject.id].last_scan_timestamp
    matching_manual_exit = (event["direction"] == "exit" and states[subject.id].state == "inside"
                            and states[subject.id].entry_override)
    held = [restrictions[item] for item in ids if restrictions.get(item, {}).get("active")]
    critical_exit = event["direction"] == "exit" and states[subject.id].state == "inside" and held
    if last_scan and (now - last_scan).total_seconds() < 10 and not matching_manual_exit and not critical_exit:
        event.update(result="denied", reason="Cooldown active", denialCode="manual_review")
    if event["direction"] == "entry" and held:
        hardware_held = any(item["subjectId"] in assets for item in held)
        event.update(result="denied", reason=("An entry restriction on carried hardware requires administrator review."
            if hardware_held and subject.kind != "hardware" else "An entry restriction requires administrator review."),
            denialCode="hardware_restricted" if hardware_held else "access_restricted",
            entryRestrictions=held)
        decision["entryRestrictions"] = held

    if location_conflict:
        conflicting_subject, entry_building_id = location_conflict
        source_zone = BUILDING_NAMES.get(entry_building_id, entry_building_id or "an unrecorded zone")
        target_zone = cp.get("name", checkpoint.id)
        reason = (
            f"Cross-zone scan blocked. {subjects_by_id[conflicting_subject.id].get('name', conflicting_subject.barcode)} "
            f"is checked into {source_zone} and must exit there before scanning at {target_zone}."
        )
        event.update(result="denied", reason=reason, denialCode="cross_building_access")

    manual_approval_request = None if location_conflict else await _approved_manual_review(
        db, subject.barcode, checkpoint.id, event["direction"], payload.selected_hardware_ids, now,
    )
    if manual_approval_request and not (event["direction"] == "entry" and held):
        request_data = dict(manual_approval_request.data)
        initial_result = event["result"]
        initial_reason = event.get("reason")
        initial_scan_type = event.get("scanType")
        event.update(
            result="approved",
            reason="Manual approval used",
            scanType="manual",
            syncState="synced",
            manualApprovalRequestId=manual_approval_request.id,
            manualApprovedAt=now.isoformat(),
            manualApprovalValidTo=request_data.get("validTo"),
            manualApprovalReason=request_data.get("decisionReason") or "",
            adminId=request_data.get("decidedBy") or "unknown",
            initialResult=initial_result,
            initialReason=initial_reason,
            initialScanType=initial_scan_type,
        )
        event.pop("denialCode", None)
        request_data.update(
            consumedAt=now.isoformat(),
            consumedMovementId=event["id"],
            consumedBy=terminal_id,
        )
        manual_approval_request.data = request_data

    updated = apply_movement_state(event, people, hardware)
    if event["result"] == "approved":
        for sub in subjects:
            states[sub.id].state = "inside" if event["direction"] == "entry" else "outside"
            states[sub.id].entry_building_id = building_id if event["direction"] == "entry" else None
            states[sub.id].last_scan_timestamp = now
            states[sub.id].entry_override = (
                {"requestId": manual_approval_request.id,
                 "hardwareIds": list(payload.selected_hardware_ids),
                 "validTo": manual_approval_request.data.get("validTo")}
                if manual_approval_request and event["direction"] == "entry" else None
            )
            metadata = sub.hardware if sub.kind == "hardware" else sub.person
            metadata.data = {k: v for k, v in next(d for d in [*updated["people"], *updated["hardware"]] if d["id"] == sub.id).items()
                             if k not in {"entryOverride", "entryRestriction"}}
    db.add(Movement(id=event["id"], subject_id=subject.id, checkpoint_id=checkpoint.id,
        occurred_at=now, result=event["result"], direction=event["direction"],
        denial_code=event.get("denialCode"), scan_type=event.get("scanType", payload.scan_type),
        subject_type=subject.kind, sync_state=event["syncState"], data=event))
    await db.flush()
    if location_conflict:
        alert_id = str(uuid.uuid4())
        conflicting_subject, _ = location_conflict
        conflicting_data = subjects_by_id[conflicting_subject.id]
        alert_data = {
            "id": alert_id,
            "severity": "high",
            "status": "open",
            "title": "Cross-zone access attempt",
            "reason": event["reason"],
            "subjectName": conflicting_data.get("name") or conflicting_subject.barcode,
            "subjectId": conflicting_subject.id,
            "subjectType": conflicting_subject.kind,
            "barcode": conflicting_subject.barcode,
            "checkpoint": cp.get("name", checkpoint.id),
            "date": event["date"],
            "time": event["time"],
            "category": "access_violation",
            "sourceEventId": event["id"],
            "explanation": "A person already inside one zone scanned at a different zone. They must exit through the zone where they entered before scanning at the other zone.",
            "createdAt": now.isoformat(),
        }
        db.add(AlertModel(id=alert_id, source_event_id=event["id"], created_at=now, data=alert_data))
        db.info["scan_alerts"] = [alert_data]
    result = {"allowed": event["result"] == "approved", "reason": event.get("reason"),
        "subject_id": subject.id, "decision": decision, "updatedPeople": updated["people"],
        "updatedHardwareAssets": updated["hardware"],
        "manualApprovalRequest": manual_approval_request.data if manual_approval_request else None}
    db.add(ScanRequest(idempotency_key=key, subject_id=subject.id, terminal_id=terminal_id,
        status_code=200, response_body=result, request_fingerprint=fingerprint))
    await db.flush()
    return result
