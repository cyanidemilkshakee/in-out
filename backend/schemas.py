from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime
import uuid


class ScanPayload(BaseModel):
    barcode: str = Field(..., min_length=1, max_length=256, strip_whitespace=True)
    terminal_id: str = Field(..., min_length=1, max_length=128, strip_whitespace=True)
    checkpoint_id: str = Field(..., min_length=1, max_length=128, strip_whitespace=True)
    direction: str = Field(..., pattern="^(entry|exit)$")


class ScanResponse(BaseModel):
    allowed: bool
    reason: Optional[str] = None
    subject_id: Optional[str] = None


# ── Phase 2 schemas ────────────────────────────────────────────────────────────

class PresenceEntry(BaseModel):
    subject_id: str
    kind: str
    barcode: str
    state: str
    last_scan_timestamp: Optional[datetime] = None
    updated_at: datetime


class MovementEntry(BaseModel):
    id: str
    subject_id: str
    checkpoint_id: str
    occurred_at: datetime
    denial_code: Optional[str] = None
    result: str
    direction: str
    scan_type: str
    subject_type: str
    sync_state: str
    data: dict


class MovementListResponse(BaseModel):
    items: list[MovementEntry]
    total: int
    limit: int
    offset: int


# ── Phase 3 schemas ────────────────────────────────────────────────────────────

class SubjectCreate(BaseModel):
    barcode: str = Field(..., min_length=1, max_length=256, strip_whitespace=True)
    kind: str = Field(..., pattern="^(employee|visitor|hardware)$")
    data: dict = Field(..., description="JSON metadata for the person or hardware")


class SubjectUpdate(BaseModel):
    barcode: Optional[str] = Field(None, min_length=1, max_length=256, strip_whitespace=True)
    data: Optional[dict] = Field(None, description="Partial or full update of JSON metadata")


class SubjectResponse(BaseModel):
    id: str
    barcode: str
    kind: str
    data: dict


class SubjectListResponse(BaseModel):
    items: list[SubjectResponse]
    total: int
    limit: int
    offset: int

