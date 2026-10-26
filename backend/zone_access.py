"""Compatibility helpers for the facility's fixed public/secure areas.

Administrators retain facility-wide access. These helpers validate legacy
zone/checkpoint references for shared query paths without organization branches
or per-zone administrator assignments.
"""
from fastapi import HTTPException
from sqlalchemy import false, select, true

from auth import has_admin_role
from facility_zones import CHECKPOINTS, CHECKPOINT_IDS, FACILITY_ZONES
from models import Alert, AlertReview, Checkpoint, CriticalAlertTrigger, Subject


async def admin_zone_ids(db, actor: dict) -> tuple[str, ...]:
    if not has_admin_role(actor):
        raise HTTPException(status_code=403, detail="Administrator access is required")
    return FACILITY_ZONES


async def require_zone_scope(db, actor: dict, zone_id: str):
    if zone_id not in await admin_zone_ids(db, actor):
        raise HTTPException(status_code=404, detail="Facility zone not found")
    return zone_id


async def require_checkpoint_scope(db, actor: dict, checkpoint_id: str) -> Checkpoint:
    if checkpoint_id not in CHECKPOINT_IDS:
        raise HTTPException(status_code=404, detail="Checkpoint not found")
    await admin_zone_ids(db, actor)
    checkpoint = await db.get(Checkpoint, checkpoint_id)
    if checkpoint is None:
        raise HTTPException(status_code=404, detail="Checkpoint not found")
    return checkpoint


def subject_zone_condition(zone_ids):
    return true() if set(zone_ids or ()) & set(FACILITY_ZONES) else false()


def checkpoint_zone_condition(model, zone_ids):
    checkpoints = [item["id"] for item in CHECKPOINTS if item["zone"] in set(zone_ids or ())]
    return model.checkpoint_id.in_(checkpoints) if checkpoints else false()


async def require_subject_scope(db, actor: dict, subject_id: str) -> Subject:
    await admin_zone_ids(db, actor)
    subject = await db.get(Subject, subject_id)
    if subject is None:
        raise HTTPException(status_code=404, detail="Subject not found")
    return subject


async def require_alert_scope(db, actor: dict, alert_id: str) -> dict:
    alert = await db.get(Alert, alert_id)
    if alert is not None:
        data = alert.data or {}
    else:
        review = await db.scalar(select(AlertReview).where(AlertReview.alert_id == alert_id))
        if review is not None:
            data = {**(review.alert_data or {}), "subjectId": review.subject_id}
        else:
            # Critical holds survive alert retention too, and must remain
            # explicitly releasable by an administrator after the alert row
            # has been purged.
            trigger = await db.get(CriticalAlertTrigger, alert_id)
            if trigger is None:
                raise HTTPException(status_code=404, detail="Alert not found")
            data = {"subjectId": trigger.subject_id}
    checkpoint_id = data.get("checkpointId")
    if isinstance(checkpoint_id, str) and checkpoint_id:
        await require_checkpoint_scope(db, actor, checkpoint_id)
        return data
    zone_id = data.get("zoneId")
    if isinstance(zone_id, str) and zone_id in FACILITY_ZONES:
        await require_zone_scope(db, actor, zone_id)
        return data
    subject_id = data.get("subjectId")
    if isinstance(subject_id, str) and subject_id.strip():
        subject_id = subject_id.strip()
        if await db.get(Subject, subject_id) is not None:
            await require_subject_scope(db, actor, subject_id)
            return data
    # Administrators have facility-wide scope. Keep legacy or unbound alerts
    # reviewable so the review service can validate their barcode/subject link.
    await admin_zone_ids(db, actor)
    return data


def validate_zone_subset(zone_ids, allowed_zone_ids):
    from fastapi import HTTPException

    normalized = list(dict.fromkeys(zone_ids))
    if not normalized:
        raise HTTPException(status_code=422, detail="Choose at least one facility zone")
    if any(zone_id not in allowed_zone_ids for zone_id in normalized):
        raise HTTPException(status_code=403, detail="One or more zones are unavailable")
    return normalized
