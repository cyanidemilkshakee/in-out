"""Transactional scan processing shared by browser and certificate terminals."""
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload
from sqlalchemy.dialects.postgresql import insert

from models import Subject, PresenceState, ScanRequest, Movement, Checkpoint, Alert, AlertRule
from movement_logic import evaluate_scan, apply_movement_state, denial_code_for_reason


async def record_scan(db, key, payload, terminal_id):
    # Serialize retries even when a caller reuses a key for a different subject.
    await db.execute(select(func.pg_advisory_xact_lock(key.int % (2**63 - 1))))
    cached = await db.get(ScanRequest, key)
    if cached:
        if cached.terminal_id != terminal_id:
            raise HTTPException(409, "Idempotency key belongs to another terminal")
        return cached.response_body

    subject = (await db.execute(select(Subject).where(
        func.lower(Subject.barcode) == payload.barcode.strip().lower()
    ))).scalar_one_or_none()
    if not subject:
        checkpoint = await db.get(Checkpoint, payload.checkpoint_id)
        if not checkpoint:
            raise HTTPException(422, "Checkpoint not registered")
        now = datetime.now(timezone.utc)
        direction = payload.direction or checkpoint.data.get("mode")
        if direction not in {"entry", "exit"}:
            direction = "entry"
        event = {
            "id": str(uuid.uuid4()), "date": now.date().isoformat(),
            "time": now.strftime("%H:%M:%S"), "checkpointId": checkpoint.id,
            "checkpoint": checkpoint.data.get("name", checkpoint.id), "direction": direction,
            "subjectId": "unregistered", "subjectName": "Unregistered barcode",
            "subjectType": "visitor", "barcode": payload.barcode.strip(), "result": "denied",
            "reason": "Barcode not registered", "denialCode": "barcode_not_registered",
            "scanType": payload.scan_type, "syncState": "synced" if payload.online else "queued",
            "hardwareIds": [], "createdAt": now.isoformat(),
        }
        decision = {"event": event, "carriedHardware": []}
        db.add(Movement(id=event["id"], subject_id=None, checkpoint_id=checkpoint.id,
            occurred_at=now, result="denied", direction=direction,
            denial_code="barcode_not_registered", scan_type=payload.scan_type,
            subject_type="visitor", sync_state=event["syncState"], data=event))
        result = {"allowed": False, "reason": event["reason"], "subject_id": None,
            "decision": decision, "updatedPeople": [], "updatedHardwareAssets": [],
            "generatedAlerts": []}
        db.add(ScanRequest(idempotency_key=key, subject_id=None, terminal_id=terminal_id,
            status_code=200, response_body=result))
        await db.flush()
        return result
    checkpoint = await db.get(Checkpoint, payload.checkpoint_id)
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
    for sub in subjects:
        metadata = sub.hardware if sub.kind == "hardware" else sub.person
        if metadata is None:
            raise HTTPException(422, "Subject metadata is missing")
        data = {**metadata.data, "id": sub.id, "barcode": sub.barcode}
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
        (hardware if sub.kind == "hardware" else people).append(data)

    cp = {**checkpoint.data, "id": checkpoint.id}
    if payload.direction:
        cp["mode"] = payload.direction
    decision = evaluate_scan(barcode=payload.barcode, checkpoint=cp, people=people,
        hardware=hardware, selected_hardware_ids=payload.selected_hardware_ids,
        online=payload.online, event_count=0, scan_type=payload.scan_type)
    event = decision["event"]
    event["id"] = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    last_scan = states[subject.id].last_scan_timestamp
    if last_scan and (now - last_scan).total_seconds() < 10:
        event.update(result="denied", reason="Cooldown active", denialCode="manual_review")
    updated = apply_movement_state(event, people, hardware)
    if event["result"] == "approved":
        for sub in subjects:
            states[sub.id].state = "inside" if event["direction"] == "entry" else "outside"
            states[sub.id].last_scan_timestamp = now
            metadata = sub.hardware if sub.kind == "hardware" else sub.person
            metadata.data = next(d for d in [*updated["people"], *updated["hardware"]] if d["id"] == sub.id)
    db.add(Movement(id=event["id"], subject_id=subject.id, checkpoint_id=checkpoint.id,
        occurred_at=now, result=event["result"], direction=event["direction"],
        denial_code=event.get("denialCode"), scan_type=payload.scan_type,
        subject_type=subject.kind, sync_state=event["syncState"], data=event))
    await db.flush()
    from rule_engine import create_scan_alert
    rules = (await db.execute(select(AlertRule.data))).scalars().all()
    existing = (await db.execute(select(Alert.data).where(Alert.data["status"].astext == "open"))).scalars().all()
    alert = create_scan_alert(event, decision["subject"], decision["carriedHardware"], rules, existing, str(uuid.uuid4()))
    if alert:
        db.add(Alert(id=alert["id"], source_event_id=event["id"], created_at=now, data=alert))
    result = {"allowed": event["result"] == "approved", "reason": event.get("reason"),
        "subject_id": subject.id, "decision": decision, "updatedPeople": updated["people"],
        "updatedHardwareAssets": updated["hardware"], "generatedAlerts": [alert] if alert else []}
    db.add(ScanRequest(idempotency_key=key, subject_id=subject.id, terminal_id=terminal_id,
        status_code=200, response_body=result))
    await db.flush()
    return result
