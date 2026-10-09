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


async def cleanup(*, apply: bool) -> dict[str, int]:
    now = datetime.now(timezone.utc)
    results: dict[str, int] = {}
    async with async_session() as db:
        for label, model, timestamp_field, setting_name in RETENTION_TARGETS:
            days = getattr(settings, setting_name)
            if days <= 0:
                continue
            cutoff = now - timedelta(days=days)
            field = getattr(model, timestamp_field)
            criteria = field < cutoff
            if model is Movement:
                # Do not delete a movement that is still evidence for an alert.
                criteria = and_(criteria,
                    ~exists(select(Alert.id).where(Alert.source_event_id == Movement.id)),
                    ~exists(select(PermissionRequestModel.id).where(PermissionRequestModel.data["eventId"].astext == Movement.id)))
            count = await db.scalar(select(func.count()).select_from(model).where(criteria))
            results[label] = int(count or 0)
            if apply and count:
                await db.execute(delete(model).where(criteria))
        if apply:
            await db.commit()
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
