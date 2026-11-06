"""Bounded Permission Manager views; the legacy snapshot remains available."""
from sqlalchemy import String, Text, case, cast, func, literal, or_, select
from sqlalchemy.dialects.postgresql import JSONB, array

from critical_entry_restrictions import entry_restrictions_for_subjects
from models import (AccessPermission, AuditEvent, Checkpoint, CriticalEntryRestriction,
    HardwareAsset, OrganizationZone, PermissionRequestModel, Person, Subject)
from subject_metadata import current_subject_metadata
from zone_access import subject_zone_condition


async def _checkpoints(db, zone_ids):
    rows = (await db.scalars(select(Checkpoint).where(
        Checkpoint.active.is_(True), Checkpoint.zone_id.in_(zone_ids))
        .order_by(Checkpoint.zone_id, Checkpoint.number))).all()
    return [{**row.data, "id": row.id, "zoneId": row.zone_id, "number": row.number,
        "gateType": row.gate_type, "required": row.required, "active": row.active} for row in rows]


def _literal_pattern(value):
    return "%" + value.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


async def permission_directory_page(db, zone_ids, *, limit, offset, search=None,
                                  subject_group=None, state=None, subject_id=None):
    """Page the same effective access records displayed by the existing manager."""
    metadata = case((Subject.kind == "hardware", HardwareAsset.data), else_=Person.data)
    approved_request = select(PermissionRequestModel.id).where(
        PermissionRequestModel.subject_id == Subject.id,
        PermissionRequestModel.data["status"].astext == "approved",
        PermissionRequestModel.data["type"].astext.in_(("visitor", "zone_access"))).exists()
    manual_audit = (select(AuditEvent.id).where(
        AuditEvent.data["subjectId"].astext == Subject.id,
        AuditEvent.data["category"].astext == "permission",
        # The outer subject is already in scope, satisfying the legacy audit
        # predicate's subject branch without repeating its zone subqueries.
        AuditEvent.data["action"].astext.in_(("Manual permission granted", "Manual permission changed")))
        .correlate(Subject).exists())
    has_permission = AccessPermission.subject_id.is_not(None)
    source = case((~has_permission, "policy"),
        (or_(AccessPermission.data["source"].astext == "manual", manual_audit), "manual"),
        (approved_request, "request"), else_=func.coalesce(AccessPermission.data["source"].astext, "policy"))
    policy_status = func.coalesce(metadata["status"].astext, "active")
    policy_state = case((policy_status == "pre_approved", "active"), (policy_status == "inactive", "revoked"),
        (policy_status == "maintenance", "restricted"), else_=policy_status)
    raw_state = case((has_permission, AccessPermission.data["state"].astext), else_=policy_state)
    normalized_state = case((raw_state.in_(("restricted", "pending_approval", "expired", "revoked")), raw_state), else_="active")
    display_state = case((CriticalEntryRestriction.active.is_(True), "restricted"), else_=normalized_state)
    name = case((has_permission, func.coalesce(AccessPermission.data["subjectName"].astext, "Unknown subject")),
        else_=func.coalesce(func.nullif(metadata["name"].astext, ""), Subject.barcode))
    assignment = case((has_permission, func.coalesce(AccessPermission.data["assignment"].astext, "")), else_=Subject.kind)
    raw_zones = case((has_permission, AccessPermission.data["zones"]), else_=metadata["allowedZones"])
    zones = case((func.jsonb_typeof(raw_zones) == "array", raw_zones), else_=literal([], type_=JSONB))
    one_time = (Subject.kind == "visitor") & (assignment == "One visit") & or_(
        AccessPermission.data["updatedBy"].astext == "manual-review",
        AccessPermission.data["reason"].astext.startswith("Manual approval covers one entry"))
    filters = [Subject.kind.in_(("employee", "visitor", "hardware")), subject_zone_condition(zone_ids),
        func.lower(func.btrim(name)) != "unregistered barcode", ~func.coalesce(one_time, False),
        or_(Subject.kind != "visitor", (normalized_state != "pending_approval") & or_(
            normalized_state == "active", source != "request", approved_request))]
    if subject_group:
        filters.append(Subject.kind == "hardware" if subject_group == "hardware" else Subject.kind.in_(("employee", "visitor")))
    if subject_id:
        filters.append(Subject.id == subject_id)
    if state and state != "all":
        filters.append(display_state == state)
    if search and search.strip():
        pattern = _literal_pattern(search)
        named_zone = select(OrganizationZone.id).where(zones.op("?")(OrganizationZone.id),
            OrganizationZone.name.ilike(pattern, escape="\\")).correlate(Subject, Person, HardwareAsset, AccessPermission).exists()
        searchable = func.concat_ws(" ", name, assignment, Subject.barcode,
            func.coalesce(metadata["assignedEmployeeName"].astext, ""), cast(zones, Text))
        filters.append(or_(searchable.ilike(pattern, escape="\\"), named_zone))
    query = (select(Subject, Person.data, HardwareAsset.data, AccessPermission, source.label("source"))
        .outerjoin(Person, Person.subject_id == Subject.id)
        .outerjoin(HardwareAsset, HardwareAsset.subject_id == Subject.id)
        .outerjoin(AccessPermission, AccessPermission.subject_id == Subject.id)
        .outerjoin(CriticalEntryRestriction, CriticalEntryRestriction.subject_id == Subject.id).where(*filters))
    total = int(await db.scalar(select(func.count()).select_from(query.with_only_columns(Subject.id).subquery())) or 0)
    rows = (await db.execute(query.order_by(func.lower(name), Subject.id).limit(limit).offset(offset))).all()
    restrictions = await entry_restrictions_for_subjects(db, [row[0].id for row in rows])
    items, people, hardware = [], [], []
    for subject, person_data, hardware_data, permission, permission_source in rows:
        data = hardware_data if subject.kind == "hardware" else person_data
        data = current_subject_metadata(subject.kind, data or {})
        subject_doc = {**data, "id": subject.id, "barcode": subject.barcode, "type": subject.kind,
            "entryRestriction": restrictions.get(subject.id)}
        (hardware if subject.kind == "hardware" else people).append(subject_doc)
        if permission:
            record = {**(permission.data or {})}
            record.setdefault("id", permission.id)
            record.setdefault("subjectId", subject.id)
            record.update(barcode=subject.barcode, subjectType=subject.kind, source=permission_source)
        else:
            status = data.get("status", "active")
            record = {"id": f"subject-{subject.id}", "subjectId": subject.id, "barcode": subject.barcode,
                "subjectName": data.get("name") or subject.barcode, "subjectType": subject.kind,
                "assignment": subject.kind.title(), "state": {"pre_approved": "active", "inactive": "revoked", "maintenance": "restricted"}.get(status, status),
                "zones": data.get("allowedZones") or [], "validFrom": data.get("validFrom") or "",
                "validTo": data.get("validTo") or "", "source": "policy", "updatedAt": data.get("createdAt") or "", "updatedBy": "system"}
        record["entryRestriction"] = restrictions.get(subject.id)
        items.append(record)
    return {"items": items, "people": people, "hardwareAssets": hardware, "checkpoints": await _checkpoints(db, zone_ids),
        "total": total, "limit": limit, "offset": offset}


async def pending_permission_page(db, zone_ids, *, limit, offset, search=None, subject_id=None,
                                  request_id=None, type_group=None):
    visible_subjects = select(Subject.id).where(subject_zone_condition(zone_ids)).correlate(None)
    status = PermissionRequestModel.data["status"].astext
    filters = [func.coalesce(status, "pending").not_in(("approved", "denied")), or_(
        PermissionRequestModel.data["requestedZones"].has_any(array(list(zone_ids), type_=String)),
        PermissionRequestModel.data["checkpointId"].astext.in_(select(Checkpoint.id).where(Checkpoint.zone_id.in_(zone_ids))),
        PermissionRequestModel.subject_id.in_(visible_subjects))]
    if subject_id:
        filters.append(PermissionRequestModel.subject_id == subject_id)
    if request_id:
        filters.append(PermissionRequestModel.id == request_id)
    if search and search.strip():
        pattern = _literal_pattern(search)
        filters.append(or_(*(PermissionRequestModel.data[field].astext.ilike(pattern, escape="\\")
            for field in ("subjectName", "barcode", "purpose", "operatorNote", "checkpoint"))))
    request_type = PermissionRequestModel.data["type"].astext
    manual = or_(request_type.is_(None), request_type.not_in(("visitor", "hardware_custody", "zone_access")))
    summary = (await db.execute(select(func.count().filter(manual).label("manual"),
        func.count().filter(~manual).label("other")).where(*filters))).mappings().one()
    if type_group:
        filters.append(manual if type_group == "manual" else ~manual)
    total = int(summary[type_group] if type_group else sum(summary.values()))
    rows = (await db.scalars(select(PermissionRequestModel).where(*filters)
        .order_by(PermissionRequestModel.created_at.desc(), PermissionRequestModel.id)
        .limit(limit).offset(offset))).all()
    # Current access/custody comparisons need only the subjects referenced by
    # this queue page. Apply scope again before resolving related identities.
    subject_ids = {row.subject_id for row in rows if row.subject_id}
    subject_ids.update(value for row in rows for key in ("subjectId", "hardwareId", "carrierId")
        if isinstance(value := (row.data or {}).get(key), str) and value)
    related = (await db.execute(select(Subject, Person.data, HardwareAsset.data)
        .outerjoin(Person, Person.subject_id == Subject.id)
        .outerjoin(HardwareAsset, HardwareAsset.subject_id == Subject.id)
        .where(Subject.id.in_(subject_ids), subject_zone_condition(zone_ids)).order_by(Subject.id))).all() if subject_ids else []
    restrictions = await entry_restrictions_for_subjects(db, [row[0].id for row in related])
    people, hardware = [], []
    for subject, person_data, hardware_data in related:
        data = hardware_data if subject.kind == "hardware" else person_data
        document = {**current_subject_metadata(subject.kind, data or {}), "id": subject.id,
            "barcode": subject.barcode, "type": subject.kind, "entryRestriction": restrictions.get(subject.id)}
        (hardware if subject.kind == "hardware" else people).append(document)
    return {"items": [row.data for row in rows], "checkpoints": await _checkpoints(db, zone_ids),
        "people": people, "hardwareAssets": hardware,
        "summary": {key: int(value) for key, value in summary.items()}, "total": total, "limit": limit, "offset": offset}
