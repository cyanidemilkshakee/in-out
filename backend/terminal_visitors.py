"""Cursor-paged visitor roster for a terminal's assigned checkpoint."""
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, lateral, or_, select, true

from facility_zones import normalize_facility_document
from models import AccessPermission, Checkpoint, Person, PermissionRequestModel, Subject


def _status(metadata, permission_data, registration_request, now):
    valid_to = permission_data.get("validTo") or metadata.get("validTo") or (registration_request or {}).get("validTo")
    expired = False
    if isinstance(valid_to, str) and valid_to:
        try:
            expiry = datetime.fromisoformat(valid_to.replace("Z", "+00:00"))
            if expiry.tzinfo is None:
                expiry = expiry.replace(tzinfo=timezone(timedelta(hours=5, minutes=30)))
            expired = expiry <= now
        except ValueError:
            pass
    request_status = (registration_request or {}).get("status")
    permission_state = permission_data.get("state")
    if request_status == "pending" or permission_state == "pending_approval":
        return "pending"
    if request_status == "denied" and permission_state != "active":
        return "denied"
    if permission_state == "restricted":
        return "restricted"
    if permission_state == "revoked":
        return "inactive"
    if permission_state == "expired" or expired:
        return "expired"
    if permission_state == "active" or request_status == "approved":
        return "approved"
    return "inactive"


async def terminal_visitors_page(db, checkpoint_id: str, checkpoint: Checkpoint | None,
                                 *, cursor: str | None = None, limit: int = 100) -> dict:
    """Return one stable ID-ordered page without materializing visitor history."""
    zone_id = checkpoint.zone_id if checkpoint else None
    latest_request = lateral(
        select(
            PermissionRequestModel.data.label("request_data"),
        )
        .where(PermissionRequestModel.subject_id == Subject.id)
        .where(PermissionRequestModel.data["type"].astext == "visitor")
        .where(PermissionRequestModel.data["checkpointId"].astext == checkpoint_id)
        .order_by(PermissionRequestModel.created_at.desc(), PermissionRequestModel.id.desc())
        .limit(1)
    ).alias("latest_visitor_request")

    eligibility = [latest_request.c.request_data.is_not(None)]
    if zone_id:
        eligibility.extend((
            and_(
                AccessPermission.data["state"].astext == "active",
                AccessPermission.data["zones"].contains([zone_id]),
            ),
        ))

    query = (
        select(Subject, Person, AccessPermission, latest_request.c.request_data)
        .join(Person, Person.subject_id == Subject.id)
        .outerjoin(AccessPermission, AccessPermission.subject_id == Subject.id)
        .outerjoin(latest_request, true())
        .where(Subject.kind == "visitor")
        .where(or_(*eligibility))
        .order_by(Subject.id)
        .limit(limit + 1)
    )
    if cursor:
        query = query.where(Subject.id > cursor)

    rows = (await db.execute(query)).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    now = datetime.now(timezone.utc)
    items = []
    for subject, person, permission, registration_request in rows:
        metadata = normalize_facility_document(dict(person.data or {}))
        permission_data = normalize_facility_document(dict(permission.data or {})) if permission else {}
        registration_request = dict(registration_request or {})
        request_zones = registration_request.get("requestedZones") or []
        permission_zones = permission_data.get("zones") if isinstance(permission_data.get("zones"), list) else []
        zones = permission_zones or metadata.get("allowedZones") or request_zones
        zones = [zone for zone in zones if isinstance(zone, str)] if isinstance(zones, list) else []
        if not registration_request and not (
            permission_data.get("state") == "active" and zone_id in zones
        ):
            continue

        valid_from = permission_data.get("validFrom") or metadata.get("validFrom") or registration_request.get("validFrom")
        valid_to = permission_data.get("validTo") or metadata.get("validTo") or registration_request.get("validTo")
        items.append({
            "id": subject.id,
            "name": str(metadata.get("name") or subject.barcode),
            "barcode": subject.barcode,
            "host": metadata.get("host") if isinstance(metadata.get("host"), str) else "",
            "company": metadata.get("company") if isinstance(metadata.get("company"), str) else "",
            "allowedZones": zones,
            "validFrom": valid_from if isinstance(valid_from, str) else "",
            "validTo": valid_to if isinstance(valid_to, str) else "",
            "createdAt": metadata.get("createdAt") if isinstance(metadata.get("createdAt"), str) else "",
            "status": _status(metadata, permission_data, registration_request, now),
        })
    return {
        "items": items,
        "nextCursor": rows[-1][0].id if has_more and rows else None,
        "hasMore": has_more,
        "checkpointId": checkpoint_id,
    }
