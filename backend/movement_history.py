"""Read-only asset history derived from canonical carrier scans.

One terminal action remains one persisted movement. A carried asset gets a
stable virtual event in history so it can be paged, searched and counted just
like a directly scanned asset, including scans recorded before this view.
"""
from sqlalchemy import String, Text, case, cast, column, func, literal, literal_column, select, true, union_all
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import aliased

from models import HardwareAsset, Movement, PermissionRequestModel, Subject


def canonical_movement_filter(model=Movement):
    """Old reviews created a replacement event; count that revision only once."""
    review = aliased(Movement)
    return ~select(PermissionRequestModel.id).join(review,
        review.data["overrideRequestId"].astext == PermissionRequestModel.id).where(
            PermissionRequestModel.data["type"].astext == "manual_override",
            PermissionRequestModel.data["eventId"].astext == model.id,
            review.id != model.id,
        ).correlate(model).exists()


def _array(value):
    return case((func.jsonb_typeof(value) == "array", value), else_=cast(literal("[]"), JSONB))


def movement_history(*, include_replaced=False, hardware_only=False):
    """Return a Movement-shaped alias; virtual rows never enter write paths."""
    source = Movement.__table__
    elements = func.jsonb_array_elements(_array(Movement.data["hardwareIds"])).table_valued(
        column("value", JSONB)).alias("hardware_element")
    element_id = elements.c.value.op("#>>", return_type=Text)(literal_column("'{}'"))
    carried = select(element_id.label("asset_id")).where(
        func.jsonb_typeof(elements.c.value) == "string",
        element_id != "",
    ).distinct().correlate(source).lateral("carried_asset")
    snapshots = func.jsonb_array_elements(_array(Movement.data["hardwareSnapshots"])).table_valued(
        column("value", JSONB)).alias("hardware_snapshot")
    snapshot = select(snapshots.c.value).where(
        snapshots.c.value["id"].astext == carried.c.asset_id,
    ).limit(1).correlate(source, carried).scalar_subquery()
    snapshot_name = snapshot["name"].astext
    snapshot_barcode = snapshot["barcode"].astext
    asset_name = func.coalesce(func.nullif(snapshot_name, ""), HardwareAsset.data["name"].astext,
        Subject.barcode, carried.c.asset_id)
    asset_barcode = func.coalesce(func.nullif(snapshot_barcode, ""), Subject.barcode, carried.c.asset_id)
    # A JSON array supplies unambiguous boundaries between arbitrary IDs. The
    # namespace keeps these identifiers separate from other derived records.
    event_id = cast(cast(func.md5(cast(func.jsonb_build_array(
        "inout-carried-hardware-v1", Movement.id, carried.c.asset_id), Text)), UUID), String)
    projected_data = Movement.data.op("||")(func.jsonb_build_object(
        "id", event_id, "subjectId", carried.c.asset_id, "subjectType", "hardware",
        "subjectName", asset_name, "barcode", asset_barcode,
        "sourceEventId", Movement.id, "carrierId", Movement.subject_id,
        "carrierName", Movement.data["subjectName"].astext,
        "result", Movement.result, "direction", Movement.direction,
        "scanType", Movement.scan_type, "syncState", Movement.sync_state,
        "checkpointId", Movement.checkpoint_id,
        "hardwareIds", cast(literal("[]"), JSONB),
    ))
    projected = select(*(
        event_id.label("id") if name == "id" else
        carried.c.asset_id.label("subject_id") if name == "subject_id" else
        literal("hardware").label("subject_type") if name == "subject_type" else
        projected_data.label("data") if name == "data" else source.c[name]
        for name in source.c.keys()
    )).select_from(source.join(carried, true())
        .outerjoin(Subject, (Subject.id == carried.c.asset_id) & (Subject.kind == "hardware"))
        .outerjoin(HardwareAsset, HardwareAsset.subject_id == Subject.id)).where(
            Movement.subject_type.in_(["employee", "visitor"]))
    original = select(*source.c)
    if hardware_only:
        original = original.where(Movement.subject_type == "hardware")
    if not include_replaced:
        original = original.where(canonical_movement_filter())
        projected = projected.where(canonical_movement_filter())
    view = union_all(original, projected).subquery("movement_history")
    return aliased(Movement, view, adapt_on_names=True)


def source_event_id(movement):
    """Notes belong to the physical scan, including when shown for an asset."""
    return (movement.data or {}).get("sourceEventId") or movement.id
