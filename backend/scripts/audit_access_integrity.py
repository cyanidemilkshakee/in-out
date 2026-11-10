"""Read-only count of legacy access records affected by access hardening.

Run from the backend environment with database settings configured:
    python scripts/audit_access_integrity.py

Only aggregate counts are printed; no records are changed or identifiers exposed.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import func, or_, select  # noqa: E402

from access_validation import parse_validity  # noqa: E402
from database import async_session  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from models import AccessPermission, Person, Subject  # noqa: E402


async def audit() -> dict[str, int]:
    async with async_session() as db:
        employee_category_count = int(await db.scalar(select(func.count()).select_from(Subject)
            .join(Person, Person.subject_id == Subject.id)
            .where(Subject.kind == "employee", Person.data["category"].astext.is_not(None))) or 0)

        visitor_rows = (await db.execute(select(AccessPermission.data)
            .join(Subject, Subject.id == AccessPermission.subject_id)
            .where(Subject.kind == "visitor", AccessPermission.data["state"].astext == "active",
                or_(AccessPermission.data["validTo"].astext.is_(None),
                    AccessPermission.data["validTo"].astext == "")))).scalars().all()
        missing_expiry = 0
        malformed_expiry = 0
        for permission in visitor_rows:
            valid_to = (permission or {}).get("validTo")
            if not valid_to:
                missing_expiry += 1
                continue
            try:
                parse_validity(valid_to)
            except (HTTPException, TypeError, ValueError):
                malformed_expiry += 1

        # Include active visitor permissions with malformed timestamps as a
        # separate count; the current query above intentionally targets blanks.
        malformed_rows = (await db.execute(select(AccessPermission.data)
            .join(Subject, Subject.id == AccessPermission.subject_id)
            .where(Subject.kind == "visitor", AccessPermission.data["state"].astext == "active",
                AccessPermission.data["validTo"].astext.is_not(None),
                AccessPermission.data["validTo"].astext != ""))).scalars().all()
        for permission in malformed_rows:
            try:
                parse_validity((permission or {}).get("validTo"))
            except (HTTPException, TypeError, ValueError):
                malformed_expiry += 1

        return {"employeeRecordsWithCategory": employee_category_count,
            "activeVisitorPermissionsMissingExpiry": missing_expiry,
            "activeVisitorPermissionsWithInvalidExpiry": malformed_expiry}


if __name__ == "__main__":
    print(json.dumps(asyncio.run(audit()), indent=2, sort_keys=True))
