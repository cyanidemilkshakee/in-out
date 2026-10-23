"""Transactional scan processing shared by browser and certificate terminals."""
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from config import settings
from sqlalchemy import select, func, tuple_
from sqlalchemy.orm import selectinload
from sqlalchemy.dialects.postgresql import insert

from models import Subject, PresenceState, ScanRequest, Movement, Checkpoint, AccessPermission, PermissionRequestModel, Alert as AlertModel
from movement_logic import evaluate_scan, apply_movement_state, _current_date, _current_time
from alert_rule_assignments import alert_rule_catalog
from access_validation import parse_validity, require_registered_checkpoint
from facility_zones import (
    CHECKPOINTS,
    BUILDING_NAMES,
    building_for_checkpoint,
    canonical_checkpoint_id,
    compatible_request_fingerprints,
    normalize_facility_document,
)
from critical_entry_restrictions import (
    entry_restrictions_for_subjects,
    entry_restrictions_for_locked_subjects,
)
from subject_metadata import current_subject_metadata
from behavior_limits import consume_unknown_barcode_quota
from manual_review_policy import manual_access_snapshot

_MANUAL_REVIEW_PAGE_SIZE = 50
_MAX_MANUAL_REVIEW_CANDIDATES = 500


def validate_queued_scan_age(payload, *, now=None):
    """A receipt miss must not turn declared expired queue evidence into a new scan.

    The browser sends its immutable server-anchored retry timestamp separately
    from the attempted payload. Older physical/offline clients can only declare
    their original captured_offline_at. These fields can reject a retry; they
    never grant access or replace the current access/presence checks.
    """
    captured = getattr(payload, "queue_captured_at", None) or payload.captured_offline_at
    if captured is None:
        return
    now = now or datetime.now(timezone.utc)
    if captured.tzinfo is None or captured.utcoffset() is None or captured > now:
        raise HTTPException(409, detail={"code": "offline_replay_time_unverifiable",
            "message": "Queued scan time cannot be verified; preserve and export it for administrator reconciliation"})
    days = settings.IDEMPOTENCY_RETENTION_DAYS
    if days > 0 and now - captured >= timedelta(days=days):
        raise HTTPException(409, detail={"code": "offline_replay_expired",
            "message": "Queued scan is outside the supported retry window; preserve and export it for administrator reconciliation"})


async def _manual_review_candidates(db, barcode, checkpoint_ids, direction):
    """Read bounded pages without confusing an arbitrary sample with absence."""
    query = select(PermissionRequestModel).where(
        PermissionRequestModel.data["type"].astext == "manual_override",
        PermissionRequestModel.data["status"].astext == "approved",
        PermissionRequestModel.data["consumedAt"].astext.is_(None),
        func.lower(PermissionRequestModel.data["barcode"].astext) == barcode.lower(),
        PermissionRequestModel.data["checkpointId"].astext.in_(checkpoint_ids),
        PermissionRequestModel.data["direction"].astext == direction,
    ).order_by(PermissionRequestModel.created_at.desc(), PermissionRequestModel.id.desc())
    cursor, checked = None, 0
    while checked < _MAX_MANUAL_REVIEW_CANDIDATES:
        page_query = query if cursor is None else query.where(
            tuple_(PermissionRequestModel.created_at, PermissionRequestModel.id) < cursor)
        page_size = min(_MANUAL_REVIEW_PAGE_SIZE, _MAX_MANUAL_REVIEW_CANDIDATES - checked)
        requests = (await db.scalars(page_query.limit(page_size).with_for_update()
            .execution_options(populate_existing=True))).all()
        for request in requests:
            checked += 1
            yield request
        if len(requests) < page_size:
            return
        cursor = (requests[-1].created_at, requests[-1].id)

    # One identifier proves whether the bounded search was complete. Do not
    # load another JSON document or silently deny when more candidates exist.
    more = await db.scalar(query.with_only_columns(PermissionRequestModel.id).where(
        tuple_(PermissionRequestModel.created_at, PermissionRequestModel.id) < cursor).limit(1))
    if more is not None:
        raise HTTPException(503, detail={"code": "manual_review_capacity_exceeded",
            "message": "Manual approval history exceeds the safe lookup capacity; request a new review",
            "maximum": _MAX_MANUAL_REVIEW_CANDIDATES})


async def _approved_manual_review(db, barcode, subject_id, subject_kind, checkpoint_id, direction, hardware_ids, now, states, current_custody, current_access):
    """Lock and return one unused approval whose entry window is still open."""
    checkpoint_ids = [checkpoint_id]
    async for request in _manual_review_candidates(db, barcode, checkpoint_ids, direction):
        data = request.data or {}
        try:
            valid_from = parse_validity(data.get("validFrom"))
            valid_to = parse_validity(data.get("validTo"))
        except HTTPException:
            continue
        if not valid_from <= now < valid_to:
            continue

        # An approved request is valid only for the exact denied scan that
        # created it. Legacy requests without a source event must fail closed.
        source_event_id = data.get("eventId")
        if not source_event_id:
            continue
        source = await db.get(Movement, source_event_id)
        if not source or source.result != "denied":
            continue
        if canonical_checkpoint_id(source.checkpoint_id) != canonical_checkpoint_id(data.get("checkpointId")):
            continue
        if source.direction != data.get("direction"):
            continue
        source_data = source.data if isinstance(source.data, dict) else {}
        if str(source_data.get("barcode") or "").casefold() != barcode.casefold():
            continue
        if request.subject_id != subject_id:
            continue
        if source.subject_id and source.subject_id != subject_id:
            continue
        # Unregistered scans have no subject FK. Their approval can only
        # create/admit a visitor, never a subsequently registered employee or
        # hardware asset sharing that barcode.
        if source.subject_id is None and subject_kind != "visitor":
            continue
        expected_hardware = set(source_data.get("hardwareIds") or [])
        if expected_hardware != set(hardware_ids):
            continue
        if data.get("hardwareCustody", {}) != current_custody:
            # Never bless a transfer that happened after administrator review.
            # Legacy asset grants lacking a snapshot also fail closed.
            continue
        if data.get("accessSnapshots") != current_access:
            # Unused grants cannot override a later administrator access change.
            # Legacy grants without a reviewed snapshot require fresh review.
            continue
        if any(state.last_scan_timestamp and state.last_scan_timestamp > source.occurred_at
               for state in states.values()):
            continue
        return request
    return None


async def record_scan(db, key, payload, terminal_id, request_scope=None):
    expected_operator = getattr(payload, "expected_operator_subject", None)
    if expected_operator and terminal_id != "browser:" + expected_operator:
        raise HTTPException(403, "This scan belongs to another operator account")
    db.info["scan_replayed"] = False
    db.info["scan_alerts"] = []
    normalized = payload.model_dump(mode="json")
    # An ownership transport guard must not change a stored scan fingerprint,
    # including retries of requests sent before the guard was introduced.
    normalized.pop("expected_operator_subject", None)
    normalized.pop("queue_captured_at", None)
    normalized["barcode"] = payload.barcode.strip().lower()
    normalized["selected_hardware_ids"] = sorted(set(payload.selected_hardware_ids))
    checkpoint_id = await require_registered_checkpoint(db, payload.checkpoint_id)
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
                locked_subjects = (await db.scalars(select(Subject).where(Subject.id.in_(ids))
                    .order_by(Subject.id).with_for_update().execution_options(populate_existing=True))).all()
            else:
                locked_subjects = []
            restrictions = {subject_id: restriction for subject_id, restriction in
                (await entry_restrictions_for_locked_subjects(db, locked_subjects)).items() if restriction["active"]}
            if restrictions:
                raise HTTPException(403, "An entry restriction is active; scan again for administrator review")
        db.info["scan_replayed"] = True
        response["replayed"] = True
        response["authorizeMovement"] = False
        response["decision"] = {**replay_decision, "replayed": True, "authorizeMovement": False}
        return response

    # Check only after receipt lookup: an existing receipt is authoritative and
    # can safely replay without another movement. A miss must respect today's
    # supported retention horizon before creating any business state.
    validate_queued_scan_age(payload)
    subject = (await db.execute(select(Subject).where(
        func.lower(Subject.barcode) == payload.barcode.strip().lower()
    ))).scalar_one_or_none()
    if not subject:
        checkpoint = await db.get(Checkpoint, checkpoint_id)
        if not checkpoint:
            raise HTTPException(422, "Checkpoint not registered")
        # The denied scan is the source of any later manual approval. Keep its
        # exact, validated hardware context even before the visitor exists.
        hardware_ids = sorted(set(payload.selected_hardware_ids))
        carried_hardware = []
        if hardware_ids:
            assets = (await db.scalars(select(Subject).where(Subject.id.in_(hardware_ids))
                .order_by(Subject.id).with_for_update()
                .options(selectinload(Subject.hardware), selectinload(Subject.presence_state)))).all()
            if {asset.id for asset in assets if asset.kind == "hardware" and asset.hardware is not None} != set(hardware_ids):
                raise HTTPException(422, "Selected hardware is not registered")
            restrictions = await entry_restrictions_for_subjects(db, hardware_ids, active_only=True)
            for asset in assets:
                data = {**normalize_facility_document(asset.hardware.data), "id": asset.id, "barcode": asset.barcode}
                data["inside"] = asset.presence_state.state == "inside" if asset.presence_state else bool(data.get("inside"))
                data["entryRestriction"] = restrictions.get(asset.id)
                carried_hardware.append(data)
        # The caller supplies authenticated request state. Direct domain calls
        # need no external admission I/O, and idempotent receipts returned above
        # never spend the distinct-barcode budget during offline recovery.
        limit_identity = (request_scope or {}).get("state", {}).get("limit_identity")
        if limit_identity:
            await consume_unknown_barcode_quota(limit_identity, payload.barcode, request_scope)
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
            "scanType": "auto", "captureMethod": "manual" if payload.scan_type == "manual" else "scanner",
            "operatorIdentity": terminal_id, "syncState": "synced" if payload.online else "queued",
            "hardwareIds": hardware_ids, "createdAt": now.isoformat(),
        }
        if carried_hardware:
            event["hardwareSnapshots"] = [
                {"id": asset["id"], "name": asset.get("name") or asset["barcode"], "barcode": asset["barcode"]}
                for asset in carried_hardware
            ]
        if payload.captured_offline_at:
            event["capturedOfflineAt"] = payload.captured_offline_at.isoformat()
        decision = {"event": event, "carriedHardware": carried_hardware, "replayed": False, "authorizeMovement": False}
        db.add(Movement(id=event["id"], subject_id=None, checkpoint_id=checkpoint.id,
            occurred_at=now, result="denied", direction=direction,
            denial_code="barcode_not_registered", scan_type="auto",
            subject_type="visitor", sync_state=event["syncState"], data=event))
        await db.flush()
        result = {"allowed": False, "reason": event["reason"], "subject_id": None,
            "decision": decision, "updatedPeople": [], "updatedHardwareAssets": [],
            "replayed": False, "authorizeMovement": False}
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
        .options(selectinload(Subject.person), selectinload(Subject.hardware))
        .execution_options(populate_existing=True))).scalars().all()
    subject = next((item for item in subjects if item.id == subject.id), None)
    if subject is None or subject.barcode.casefold() != payload.barcode.strip().casefold():
        raise HTTPException(409, "This barcode changed while the scan was being processed; scan again")
    assets = {s.id for s in subjects if s.kind == "hardware"}
    if not set(payload.selected_hardware_ids).issubset(assets):
        raise HTTPException(422, "Selected hardware is not registered")
    people, hardware, states = [], [], {}
    permission_result = await db.execute(
        select(AccessPermission).where(AccessPermission.subject_id.in_(ids)).order_by(AccessPermission.id)
        .execution_options(populate_existing=True)
    )
    permissions, current_access = {}, {}
    for permission in permission_result.scalars().all():
        permissions.setdefault(permission.subject_id, permission)
    current_access = {sub.id: manual_access_snapshot(sub, permissions.get(sub.id)) for sub in subjects}
    restrictions = await entry_restrictions_for_locked_subjects(db, subjects)
    presence_defaults = []
    for sub in subjects:
        metadata = sub.hardware if sub.kind == "hardware" else sub.person
        if metadata is None:
            raise HTTPException(422, "Subject metadata is missing")
        data = {**current_subject_metadata(sub.kind, normalize_facility_document(metadata.data)), "id": sub.id, "barcode": sub.barcode}
        # Never trust an editable JSONB metadata field for this server-owned hold.
        data["entryRestriction"] = restrictions.get(sub.id)
        permission = permissions.get(sub.id)
        permission = normalize_facility_document(permission.data if permission else {})
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
        presence_defaults.append({"subject_id": sub.id, "state": "inside" if data.get("inside") else "outside"})
        (hardware if sub.kind == "hardware" else people).append(data)

    # Subject locks already serialize every movement writer for these identities.
    # Insert and lock presence in the same global order using two statements,
    # regardless of how many hardware assets accompany this scan.
    await db.execute(insert(PresenceState).values(presence_defaults)
        .on_conflict_do_nothing(index_elements=["subject_id"]))
    states = {presence.subject_id: presence for presence in (await db.execute(
        select(PresenceState).where(PresenceState.subject_id.in_(ids))
        .order_by(PresenceState.subject_id).with_for_update().execution_options(populate_existing=True)
    )).scalars().all()}
    for data in [*people, *hardware]:
        presence = states[data["id"]]
        data["inside"] = presence.state == "inside"
        data["entryOverride"] = presence.entry_override

    canonical_checkpoint = next((item for item in CHECKPOINTS if item["id"] == checkpoint.id), {})
    building_id = building_for_checkpoint(checkpoint.id)
    cp = {**(checkpoint.data or {}), **canonical_checkpoint, "id": checkpoint.id,
        "buildingId": building_id}
    if payload.direction:
        cp["mode"] = payload.direction
    subjects_by_id = {data["id"]: data for data in [*people, *hardware]}
    location_conflict = next((
        (sub, states[sub.id].entry_building_id)
        for sub in [subject, *(item for item in subjects if item.id != subject.id)]
        if states[sub.id].state == "inside" and states[sub.id].entry_building_id != building_id
    ), None)
    def zone_label(building_id):
        return BUILDING_NAMES.get(building_id, building_id or "an unrecorded location")

    decision = evaluate_scan(barcode=payload.barcode, checkpoint=cp, people=people,
        hardware=hardware, selected_hardware_ids=payload.selected_hardware_ids,
        online=payload.online, event_count=0, scan_type=payload.scan_type,
        event_id=str(uuid.uuid4()))
    event = decision["event"]
    if subject.kind != "hardware" and hardware:
        event["hardwareSnapshots"] = [
            {"id": asset["id"], "name": asset.get("name") or asset["barcode"], "barcode": asset["barcode"]}
            for asset in hardware
        ]
    # Capture method is client input. Reviewed admission classification and
    # attribution come only from a server-consumed administrator grant.
    event["captureMethod"] = "manual" if payload.scan_type == "manual" else "scanner"
    event["operatorIdentity"] = terminal_id
    event["scanType"] = "auto"
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
        source_zone = zone_label(entry_building_id)
        target_zone = zone_label(building_id)
        reason = (
            f"Cross-zone scan blocked. {subjects_by_id[conflicting_subject.id].get('name', conflicting_subject.barcode)} "
            f"is checked into {source_zone} and must exit there before scanning at {target_zone}."
        )
        event.update(result="denied", reason=reason, denialCode="cross_building_access")

    current_custody = {asset["id"]: {field: asset.get(field) for field in
        ("ownerId", "assignedEmployeeId")} for asset in hardware}
    manual_approval_request = None if location_conflict else await _approved_manual_review(
        db, subject.barcode, subject.id, subject.kind, checkpoint.id, event["direction"],
        payload.selected_hardware_ids, now, states, current_custody, current_access,
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
            was_inside = states[sub.id].state == "inside"
            if event["direction"] == "entry":
                if not was_inside:
                    states[sub.id].entry_started_at = now
                    states[sub.id].visitor_overstay_alerted_entry_at = None
                elif states[sub.id].entry_started_at is None:
                    states[sub.id].entry_started_at = now
            else:
                states[sub.id].entry_started_at = None
                states[sub.id].visitor_overstay_alerted_entry_at = None
            states[sub.id].state = "inside" if event["direction"] == "entry" else "outside"
            states[sub.id].entry_building_id = building_id if event["direction"] == "entry" else None
            states[sub.id].last_scan_timestamp = now
            states[sub.id].entry_override = (
                {"requestId": manual_approval_request.id,
                 "hardwareIds": list(payload.selected_hardware_ids),
                 "hardwareCustody": manual_approval_request.data.get("hardwareCustody", {}),
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
    person_presence = states[subject.id]
    if (event.get("denialCode") == "cross_building_access"
            and subject.kind in {"employee", "visitor"}
            and person_presence.state == "inside"
            and person_presence.entry_building_id in BUILDING_NAMES
            and building_id in BUILDING_NAMES
            and person_presence.entry_building_id != building_id):
        cross_building_rule = next((rule for rule in await alert_rule_catalog(db)
            if rule.get("conditionKey") == "cross_building_scan" and rule.get("enabled")), None)
    else:
        cross_building_rule = None
    if cross_building_rule:
        alert_id = str(uuid.uuid4())
        person_data = subjects_by_id[subject.id]
        alert_data = {
            "id": alert_id,
            "severity": "high",
            "status": "open",
            "title": "Cross-zone scan",
            "reason": event["reason"],
            "subjectName": person_data.get("name") or subject.barcode,
            "subjectId": subject.id,
            "subjectType": subject.kind,
            "barcode": subject.barcode,
            "checkpoint": cp.get("gateLabel") or cp.get("name", checkpoint.id),
            "checkpointId": checkpoint.id,
            "zoneId": checkpoint.zone_id,
            "date": event["date"],
            "time": event["time"],
            "category": cross_building_rule.get("category", "presence_anomaly"),
            "ruleId": cross_building_rule["id"],
            "conditionKey": "cross_building_scan",
            "sourceEventId": event["id"],
            "explanation": "A person recorded inside one zone scanned in another zone. They must exit through the zone where they entered before scanning in another zone.",
            "createdAt": now.isoformat(),
        }
        db.add(AlertModel(id=alert_id, source_event_id=event["id"], created_at=now, data=alert_data))
        db.info["scan_alerts"] = [alert_data]
    result = {"allowed": event["result"] == "approved", "reason": event.get("reason"),
        "subject_id": subject.id, "decision": decision, "updatedPeople": updated["people"],
        "updatedHardwareAssets": updated["hardware"],
        "manualApprovalRequest": manual_approval_request.data if manual_approval_request else None}
    result["replayed"] = False
    result["authorizeMovement"] = result["allowed"]
    decision.update(replayed=False, authorizeMovement=result["allowed"])
    db.add(ScanRequest(idempotency_key=key, subject_id=subject.id, terminal_id=terminal_id,
        status_code=200, response_body=result, request_fingerprint=fingerprint))
    await db.flush()
    return result
