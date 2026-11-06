"""Safe, explicit retention maintenance for operational records.

Run ``python -m maintenance cleanup`` to see what would be removed. Add
``--apply`` only after approving the configured retention windows.
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, delete, exists, func, select

from config import settings
from database import async_session
from models import Alert, AuditEvent, Movement, ScanRequest, PermissionRequestModel


RETENTION_TARGETS = (
    ("idempotency requests", ScanRequest, "created_at", "IDEMPOTENCY_RETENTION_DAYS"),
    ("audit events", AuditEvent, "created_at", "AUDIT_RETENTION_DAYS"),
    ("alerts", Alert, "created_at", "ALERT_RETENTION_DAYS"),
    ("movements", Movement, "occurred_at", "MOVEMENT_RETENTION_DAYS"),
)
_DELETE_BATCH_SIZE = 500


def _retention_criteria(model, field, cutoff):
    criteria = field < cutoff
    if model is Movement:
        # Keep the same evidence exclusions both when selecting candidates
        # and when deleting them from a fresh READ COMMITTED snapshot.
        criteria = and_(criteria,
            ~exists(select(Alert.id).where(Alert.source_event_id == Movement.id)),
            ~exists(select(PermissionRequestModel.id).where(PermissionRequestModel.data["eventId"].astext == Movement.id)))
    return criteria


async def _delete_batch(model, field, criteria):
    primary_key = next(iter(model.__table__.primary_key.columns))
    async with async_session() as db:
        candidates = (await db.scalars(select(primary_key).where(criteria)
            .order_by(field, primary_key).limit(_DELETE_BATCH_SIZE)
            .with_for_update(skip_locked=True))).all()
        if not candidates:
            return None
        # Recheck eligibility at DELETE time: a new evidence reference or a
        # timestamp change after selection must not be silently ignored.
        deleted = (await db.execute(delete(model).where(primary_key.in_(candidates), criteria)
            .returning(primary_key).execution_options(synchronize_session=False))).all()
        await db.commit()
        return len(deleted)


async def cleanup(*, apply: bool) -> dict[str, int]:
    """Count exact candidates, or commit bounded, independently retryable batches."""
    now = datetime.now(timezone.utc)
    results: dict[str, int] = {}
    for label, model, timestamp_field, setting_name in RETENTION_TARGETS:
        days = getattr(settings, setting_name)
        if days <= 0:
            continue
        field = getattr(model, timestamp_field)
        criteria = _retention_criteria(model, field, now - timedelta(days=days))
        if not apply:
            async with async_session() as db:
                count = await db.scalar(select(func.count()).select_from(model).where(criteria))
                results[label] = int(count or 0)
            continue
        results[label] = 0
        while True:
            removed = await _delete_batch(model, field, criteria)
            if removed is None:
                break
            results[label] += removed
    return results


async def main_async(apply: bool) -> None:
    results = await cleanup(apply=apply)
    mode = "Removed" if apply else "Would remove"
    if not results:
        print("No configured retention windows are enabled.")
        return
    for label, count in results.items():
        print(f"{mode} {count} {label}.")


def main() -> None:
    parser = argparse.ArgumentParser(description="InOut retention maintenance")
    parser.add_argument("command", choices=["cleanup"])
    parser.add_argument("--apply", action="store_true", help="perform deletion after the dry-run review")
    args = parser.parse_args()
    asyncio.run(main_async(args.apply))


if __name__ == "__main__":
    main()
