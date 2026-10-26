"""Authorization helpers for branch-scoped administrator operations."""
from fastapi import HTTPException
from sqlalchemy import false, or_, select

from auth import has_admin_role, has_master_admin_role
from models import (
    AccessPermission, Checkpoint, HardwareAsset, OrganizationZone,
    PermissionRequestModel, Person, Subject, ZoneAdminAssignment,
)


async def active_zone_ids(db) -> tuple[str, ...]:
    result = await db.scalars(
        select(OrganizationZone.id).where(OrganizationZone.active.is_(True)).order_by(OrganizationZone.name)
    )
    return tuple(result.all())


async def admin_zone_ids(db, actor: dict) -> tuple[str, ...]:
    """Return an administrator's active branches; master-admin spans all."""
    if has_master_admin_role(actor):
        return await active_zone_ids(db)
    if not has_admin_role(actor):
        raise HTTPException(status_code=403, detail="Administrator access is required")
    subject = actor.get("sub")
    if not isinstance(subject, str) or not subject:
        raise HTTPException(status_code=403, detail="Administrator identity is not available")
    result = await db.scalars(
        select(ZoneAdminAssignment.zone_id)
        .join(OrganizationZone, OrganizationZone.id == ZoneAdminAssignment.zone_id)
        .where(ZoneAdminAssignment.admin_subject == subject, OrganizationZone.active.is_(True))
        .order_by(ZoneAdminAssignment.zone_id)
    )
    zones = tuple(result.all())
    if not zones:
        raise HTTPException(status_code=403, detail="No active organization zone is assigned to this administrator")
    return zones


async def require_zone_scope(db, actor: dict, zone_id: str) -> OrganizationZone:
    # Share-lock the zone until the caller commits. Retirement takes an
    # exclusive lock, so checkpoint/admin assignment cannot race with it.
    zone = await db.scalar(select(OrganizationZone).where(
        OrganizationZone.id == zone_id).with_for_update(read=True))
    if zone is None or getattr(zone, "active", True) is False:
        raise HTTPException(status_code=404, detail="Organization zone not found")
    if zone_id not in await admin_zone_ids(db, actor):
        raise HTTPException(status_code=403, detail="This organization zone is outside your assigned scope")
    return zone


async def require_checkpoint_scope(db, actor: dict, checkpoint_id: str) -> Checkpoint:
    checkpoint = await db.get(Checkpoint, checkpoint_id)
    if checkpoint is None or getattr(checkpoint, "active", True) is False:
        raise HTTPException(status_code=404, detail="Checkpoint not found")
    await require_zone_scope(db, actor, checkpoint.zone_id)
    return checkpoint


def subject_zone_condition(zone_ids: tuple[str, ...] | list[str]):
    """SQL predicate for registered subjects visible within the given zones.

    Pending visitors may not yet have a granted permission, so their request's
    zone snapshot is included as a fallback. Historical audit/movement data is
    scoped separately by its checkpoint reference.
    """
    zones = tuple(zone_ids)
    if not zones:
        return false()
    any_zone = list(zones)
    requested_subjects = select(PermissionRequestModel.subject_id).where(
        PermissionRequestModel.subject_id.is_not(None),
        PermissionRequestModel.data["status"].astext == "pending",
        PermissionRequestModel.data["requestedZones"].has_any(any_zone),
    )
    return or_(
        select(Person.subject_id).where(Person.subject_id == Subject.id,
            or_(Person.data["allowedZones"].has_any(any_zone),
                Person.data["allowedZone"].astext.in_(zones))).exists(),
        select(HardwareAsset.subject_id).where(HardwareAsset.subject_id == Subject.id,
            or_(HardwareAsset.data["allowedZones"].has_any(any_zone),
                HardwareAsset.data["allowedZone"].astext.in_(zones))).exists(),
        select(AccessPermission.subject_id).where(AccessPermission.subject_id == Subject.id,
            AccessPermission.data["zones"].has_any(any_zone)).exists(),
        Subject.id.in_(requested_subjects),
    )


def checkpoint_zone_condition(model, zone_ids: tuple[str, ...] | list[str]):
    """SQL predicate scoping a movement/history row by its checkpoint zone."""
    zones = tuple(zone_ids)
    if not zones:
        return false()
    return model.checkpoint_id.in_(select(Checkpoint.id).where(Checkpoint.zone_id.in_(zones)))


async def require_subject_scope(db, actor: dict, subject_id: str) -> Subject:
    """Fetch a subject only when at least one of its zones is in actor scope."""
    from fastapi import HTTPException
    from sqlalchemy.orm import selectinload

    zones = await admin_zone_ids(db, actor)
    subject = await db.scalar(
        select(Subject)
        .outerjoin(Person, Person.subject_id == Subject.id)
        .outerjoin(HardwareAsset, HardwareAsset.subject_id == Subject.id)
        .outerjoin(AccessPermission, AccessPermission.subject_id == Subject.id)
        .where(Subject.id == subject_id, subject_zone_condition(zones))
        .options(selectinload(Subject.person), selectinload(Subject.hardware))
    )
    if subject is None:
        raise HTTPException(status_code=404, detail="Subject not found")
    return subject


async def require_alert_scope(db, actor: dict, alert_id: str) -> dict:
    """Resolve a live or retained alert and enforce its branch boundary."""
    from fastapi import HTTPException
    from models import Alert, AlertReview

    alert = await db.get(Alert, alert_id)
    if alert is not None:
        data = alert.data or {}
    else:
        review = await db.scalar(select(AlertReview).where(AlertReview.alert_id == alert_id))
        if review is None:
            raise HTTPException(status_code=404, detail="Alert not found")
        data = review.alert_data or {}
        data = {**data, "subjectId": review.subject_id}
    checkpoint_id = data.get("checkpointId")
    if isinstance(checkpoint_id, str) and checkpoint_id:
        await require_checkpoint_scope(db, actor, checkpoint_id)
        return data
    zone_id = data.get("zoneId")
    if isinstance(zone_id, str) and zone_id:
        await require_zone_scope(db, actor, zone_id)
        return data
    subject_id = data.get("subjectId")
    if isinstance(subject_id, str) and subject_id:
        await require_subject_scope(db, actor, subject_id)
        return data
    raise HTTPException(status_code=404, detail="Alert not found")


def validate_zone_subset(zone_ids: list[str] | tuple[str, ...], allowed_zone_ids: tuple[str, ...]) -> list[str]:
    """Reject attempts to grant or move records outside the actor's branches."""
    from fastapi import HTTPException

    normalized = list(dict.fromkeys(zone_ids))
    if not normalized:
        raise HTTPException(status_code=422, detail="Choose at least one organization zone")
    if any(zone_id not in allowed_zone_ids for zone_id in normalized):
        raise HTTPException(status_code=403, detail="One or more zones are outside your assigned scope")
    return normalized
