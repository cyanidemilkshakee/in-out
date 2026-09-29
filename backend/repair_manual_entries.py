"""Backfill historical manual admissions. Defaults to a read-only check.

Run after alembic upgrade head. --apply links approved historical movements to
registered identities and restores presence from their latest approved movement.
It never invents a new admission or changes an administrator's decision.
"""
import argparse
import asyncio
import json
import uuid
from datetime import datetime, timezone

from sqlalchemy import select, or_, and_
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import selectinload

from database import async_session, engine
from models import Subject, Movement, PermissionRequestModel, PresenceState, AccessPermission, Person, HardwareAsset
from permission_decisions import ensure_review_subject


async def repair_manual_entries(db, *, apply=False):
    movements = list((await db.scalars(select(Movement).where(
        Movement.result == "approved", Movement.data["overrideRequestId"].astext.is_not(None)
    ).order_by(Movement.occurred_at, Movement.id))).all())
    counts = {"manualApprovalsChecked": len(movements), "unlinkedMovements": 0, "presenceRepairs": 0}
    touched = set()
    for movement in movements:
        request_id = movement.data["overrideRequestId"]
        req = await db.get(PermissionRequestModel, request_id)
        if not movement.subject_id:
            counts["unlinkedMovements"] += 1
            if not apply:
                continue
            subject = await ensure_review_subject(db, {**(req.data if req else {}), **movement.data})
            movement.subject_id = subject.id
            movement.data = {**movement.data, "subjectId": subject.id, "subjectType": subject.kind}
            if req:
                req.subject_id = subject.id
                req.data = {**req.data, "subjectId": subject.id, "subjectType": subject.kind}
        touched.add(movement.subject_id)
        touched.update(movement.data.get("hardwareIds") or [])
    if apply:
        await db.flush()
    subjects = list((await db.scalars(select(Subject).where(Subject.id.in_(sorted(touched)))
        .order_by(Subject.id).with_for_update()
        .options(selectinload(Subject.person), selectinload(Subject.hardware)))).all())
    for subject in subjects:
        latest = await db.scalar(select(Movement).where(Movement.result == "approved", or_(
            Movement.subject_id == subject.id, Movement.data["hardwareIds"].contains([subject.id])
        )).order_by(Movement.occurred_at.desc(), Movement.id.desc()).limit(1))
        if not latest:
            continue
        inside = latest.direction == "entry"
        grant = ({"requestId": latest.data["overrideRequestId"], "hardwareIds": latest.data.get("hardwareIds") or []}
                 if inside and latest.data.get("overrideRequestId") else None)
        state = await db.get(PresenceState, subject.id)
        metadata = subject.hardware if subject.kind == "hardware" else subject.person
        if state and state.state == ("inside" if inside else "outside") and state.entry_override == grant and metadata and metadata.data.get("inside") == inside:
            continue
        counts["presenceRepairs"] += 1
        if apply:
            await db.execute(insert(PresenceState).values(subject_id=subject.id, state="inside" if inside else "outside",
                last_scan_timestamp=latest.occurred_at, entry_override=grant).on_conflict_do_update(
                    index_elements=["subject_id"], set_={"state": "inside" if inside else "outside",
                    "last_scan_timestamp": latest.occurred_at, "entry_override": grant}))
            if metadata:
                metadata.data = {**metadata.data, "id": subject.id, "barcode": subject.barcode, "inside": inside}
    # Preserve incomplete identities, but quarantine them until an administrator
    # supplies their details. Never infer an active permission from missing data.
    incomplete = list((await db.scalars(select(Subject)
        .outerjoin(Person, Person.subject_id == Subject.id)
        .outerjoin(HardwareAsset, HardwareAsset.subject_id == Subject.id)
        .where(or_(and_(Subject.kind == "hardware", HardwareAsset.subject_id.is_(None)),
                   and_(Subject.kind != "hardware", Person.subject_id.is_(None)))))).all())
    counts["missingMetadata"] = len(incomplete)
    if apply:
        for subject in incomplete:
            state = await db.get(PresenceState, subject.id)
            data = {"id": subject.id, "type": subject.kind, "barcode": subject.barcode,
                "name": f"Unconfigured {subject.kind}", "status": "restricted", "allowedZones": [],
                "inside": bool(state and state.state == "inside"), "requiresProfileReview": True,
                "createdAt": datetime.now(timezone.utc).isoformat()}
            if subject.kind == "hardware":
                db.add(HardwareAsset(subject_id=subject.id, data={**data, "category": "Hardware"}))
            else:
                db.add(Person(subject_id=subject.id, data=data))
        await db.flush()
    # Older registry creation omitted permission rows for employees and assets.
    missing = list((await db.scalars(select(Subject).outerjoin(AccessPermission, AccessPermission.subject_id == Subject.id)
        .where(AccessPermission.id.is_(None)).options(selectinload(Subject.person), selectinload(Subject.hardware)))).all())
    counts["missingPermissions"] = len(missing)
    if apply:
        for subject in missing:
            metadata = subject.hardware if subject.kind == "hardware" else subject.person
            if metadata is None:
                continue
            data = metadata.data
            permission_id = str(uuid.uuid4())
            state = {"pre_approved": "active", "inactive": "revoked", "maintenance": "restricted"}.get(data.get("status"), data.get("status", "restricted"))
            db.add(AccessPermission(id=permission_id, subject_id=subject.id, data={
                "id": permission_id, "subjectId": subject.id, "subjectType": subject.kind,
                "subjectName": data.get("name", subject.barcode), "assignment": subject.kind.title(),
                "state": state, "zones": data.get("allowedZones") or [], "source": "policy",
                "validFrom": data.get("validFrom") or "", "validTo": data.get("validTo") or "",
                "updatedAt": datetime.now(timezone.utc).isoformat(), "updatedBy": "registry-repair",
            }))
    return counts


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        async with async_session() as db:
            counts = await repair_manual_entries(db, apply=args.apply)
            if args.apply:
                await db.commit()
            else:
                await db.rollback()
            print(json.dumps({**counts, "applied": args.apply}))
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
