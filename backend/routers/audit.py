"""
Audit event endpoints.

GET /v1/audit-events — paginated list of audit events with optional category filter
"""

from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import String, select, func, or_
from sqlalchemy.dialects.postgresql import array
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_read_db
from data_limits import bounded_rows
from models import AuditEvent, Checkpoint, PermissionRequestModel, Person, Subject
from auth import verify_admin_request
from zone_access import admin_zone_ids, subject_zone_condition

router = APIRouter(prefix="/v1/audit-events", tags=["audit"])

_MAX_LIMIT = 200
_DEFAULT_LIMIT = 50


@router.get("")
async def list_audit_events(
    limit: int = Query(_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    offset: int = Query(0, ge=0),
    category: Optional[str] = Query(None, description="Filter by data->>'category'"),
    startAt: Optional[str] = Query(None),
    endAt: Optional[str] = Query(None),
    includeContext: bool = Query(False),
    db: AsyncSession = Depends(get_read_db),
    actor: dict = Depends(verify_admin_request),
) -> dict[str, Any]:
    """
    Return a paginated list of audit events ordered newest-first.
    Optional ?category= filters on the JSONB data->>'category' field.
    """
    zone_ids = await admin_zone_ids(db, actor)
    scope = or_(
        AuditEvent.data["zoneId"].astext.in_(zone_ids),
        AuditEvent.data["checkpointId"].astext.in_(select(Checkpoint.id).where(Checkpoint.zone_id.in_(zone_ids))),
        AuditEvent.data["subjectId"].astext.in_(
            select(Subject.id).where(subject_zone_condition(zone_ids)).correlate(None)),
    )
    q = select(AuditEvent).where(scope)
    count_q = select(func.count()).select_from(AuditEvent).where(scope)

    for value, is_start in ((startAt, True), (endAt, False)):
        if not value:
            continue
        try:
            bound = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if bound.tzinfo is None:
                bound = bound.replace(tzinfo=timezone.utc)
        except ValueError as error:
            raise HTTPException(422, "Date filter must be ISO 8601") from error
        condition = AuditEvent.created_at >= bound if is_start else AuditEvent.created_at <= bound
        q = q.where(condition)
        count_q = count_q.where(condition)

    if category:
        q = q.where(AuditEvent.data["category"].astext == category)
        count_q = count_q.where(AuditEvent.data["category"].astext == category)

    total_res = await db.execute(count_q)
    total = total_res.scalar_one()

    rows_res = await db.execute(q.order_by(AuditEvent.created_at.desc(), AuditEvent.id).limit(limit).offset(offset))
    events = rows_res.scalars().all()

    response = {
        "items":  [
            {
                **(e.data or {}),
                "id": e.id,
                "createdAt": (e.data or {}).get("createdAt") or (
                    e.created_at.isoformat() if e.created_at else None
                ),
            }
            for e in events
        ],
        "total":  total,
        "limit":  limit,
        "offset": offset,
    }
    if includeContext:
        visible_subjects = select(Subject.id).where(subject_zone_condition(zone_ids)).correlate(None)
        subject_rows = await bounded_rows(db,
            select(Subject.id, Subject.barcode, Subject.kind,
                   Person.data["name"].astext, Person.data["status"].astext)
            .join(Person, Person.subject_id == Subject.id)
            .where(Subject.kind.in_(("employee", "visitor")), subject_zone_condition(zone_ids))
            .order_by(Subject.id))
        response["people"] = [
            {"id": subject_id, "barcode": barcode, "type": kind,
             "name": name or barcode, "status": status or "active",
             "allowedZones": [], "inside": False}
            for subject_id, barcode, kind, name, status in subject_rows
        ]
        requests = await bounded_rows(db,
            select(PermissionRequestModel.data)
            .where(PermissionRequestModel.data["status"].astext.in_(("approved", "denied")))
            .where(PermissionRequestModel.data["notificationDismissedAt"].astext.is_not(None))
            .where(or_(
                PermissionRequestModel.data["requestedZones"].has_any(array(list(zone_ids), type_=String)),
                PermissionRequestModel.data["checkpointId"].astext.in_(
                    select(Checkpoint.id).where(Checkpoint.zone_id.in_(zone_ids))),
                PermissionRequestModel.subject_id.in_(visible_subjects),
            ))
            .order_by(PermissionRequestModel.created_at.desc(), PermissionRequestModel.id.desc()))
        response["permissionRequests"] = [row[0] for row in requests]
    return response
