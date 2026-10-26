"""One bounded, consistent read for reports and CSV downloads."""
import asyncio
import inspect
import json
from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.params import Param
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from auth import verify_admin_request
from config import settings
from database import get_read_db
from event_outbox import read_event_revision
from routers import movements, alerts, audit, registry

router = APIRouter(prefix="/v1/exports", tags=["reports"])


class ExportQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: Literal["movements", "alerts", "permissions", "registry"]
    kind: Literal["employee", "visitor", "hardware"] | None = None
    days: int = Field(1, ge=1, le=365)
    search: str | None = Field(None, max_length=200)
    checkpoint: str | None = Field(None, max_length=200)
    subjectGroup: Literal["people", "hardware"] | None = None
    subject_id: str | None = Field(None, min_length=1, max_length=200)
    result: Literal["approved", "denied"] | None = None
    direction: Literal["entry", "exit"] | None = None
    scanType: Literal["auto", "manual"] | None = None
    denialCategory: Literal["restricted", "other"] | None = None
    startAt: datetime | None = None
    endAt: datetime | None = None
    status: Literal["active", "open", "acknowledged", "warned", "resolved"] | None = None
    sortKey: Literal["name", "createdAt", "barcode", "status", "inside", "owner", "category", "company", "host", "validTo", "latestScan", "averageHours"] = "createdAt"
    sortDirection: Literal["asc", "desc"] = "desc"


async def _existing_read(endpoint, db, actor, **overrides):
    """Use the canonical projection/filters, without HTTP pagination caps.

    Only this authenticated bounded endpoint may supply the larger row cap;
    regular route validation and its public defaults remain unchanged.
    """
    arguments = {name: parameter.default.default
                 for name, parameter in inspect.signature(endpoint).parameters.items()
                 if isinstance(parameter.default, Param)}
    if "actor" in inspect.signature(endpoint).parameters:
        arguments["actor"] = actor
    if "_admin" in inspect.signature(endpoint).parameters:
        arguments["_admin"] = actor
    return await endpoint(**{**arguments, "db": db, **overrides})


async def build_export(db, query: ExportQuery, actor):
    revision = await read_event_revision(db)
    dates = {}
    for key in ("startAt", "endAt"):
        value = getattr(query, key)
        if value is not None:
            if value.tzinfo is None:
                value = value.replace(tzinfo=timezone.utc)
            dates[key] = value.isoformat()
    if query.startAt and query.endAt and datetime.fromisoformat(dates["startAt"]) > datetime.fromisoformat(dates["endAt"]):
        raise HTTPException(422, "The start date must precede the end date")
    maximum = min(10_000, settings.DATA_SNAPSHOT_MAX_ROWS)
    if query.source == "registry":
        if not query.kind:
            raise HTTPException(422, "Choose a registry subject kind")
        result = await _existing_read(registry.registry_bundle, db, actor, kind=query.kind, days=query.days,
            search=query.search, sortKey=query.sortKey, sortDirection=query.sortDirection,
            limit=maximum + 1, offset=0, includeOverview=False)
    elif query.source == "movements":
        result = await _existing_read(movements.list_movements, db, actor, limit=maximum + 1, page_size=maximum + 1,
            search=query.search, checkpoint=query.checkpoint, subjectGroup=query.subjectGroup,
            subject_id=query.subject_id, result=query.result, direction=query.direction, scanType=query.scanType,
            denialCategory=query.denialCategory, sortKey="createdAt", sortDirection=query.sortDirection, **dates)
    elif query.source == "alerts":
        result = await _existing_read(alerts.list_alerts, db, actor, limit=maximum + 1, status=query.status,
            search=query.search, subjectId=query.subject_id, sortKey="createdAt", sortDirection=query.sortDirection, **dates)
    else:
        result = await _existing_read(audit.list_audit_events, db, actor, limit=maximum + 1, category="permission", **dates)
    if result["total"] > maximum:
        raise HTTPException(422, f"An export can contain up to {maximum} records. Narrow the filters.")
    result["eventRevision"] = revision
    items = result.get("items", result.get("hardwareAssets" if query.kind == "hardware" else "people", []))
    if len(items) != result["total"]:
        raise HTTPException(409, "The complete export could not be read. Try again.")
    if len(json.dumps(result, separators=(",", ":"), allow_nan=False).encode()) > settings.MAX_DATA_RESPONSE_BYTES:
        raise HTTPException(413, "The export exceeds the response byte limit. Narrow the filters.")
    return result


@router.get("")
async def export_records(request: Request, query: Annotated[ExportQuery, Query()],
                         db: AsyncSession = Depends(get_read_db), _admin: dict = Depends(verify_admin_request)):
    task = asyncio.create_task(build_export(db, query, _admin))
    try:
        deadline = asyncio.get_running_loop().time() + 60
        while not task.done():
            if await request.is_disconnected():
                raise HTTPException(499, "Export cancelled")
            if asyncio.get_running_loop().time() >= deadline:
                raise HTTPException(504, "Export timed out. Narrow the filters.")
            await asyncio.wait({task}, timeout=0.1)
        return await task
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
