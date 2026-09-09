from pydantic import BaseModel, Field, ConfigDict
from typing import Optional
from datetime import datetime
import uuid


class ScanPayload(BaseModel):
    barcode: str = Field(..., min_length=1, max_length=256, strip_whitespace=True)
    terminal_id: str = Field(..., min_length=1, max_length=128, strip_whitespace=True)
    checkpoint_id: str = Field(..., min_length=1, max_length=128, strip_whitespace=True)
    direction: str = Field(..., pattern="^(entry|exit)$")
    selected_hardware_ids: list[str] = Field(default_factory=list)
    online: bool = True
    scan_type: str = Field("auto", pattern="^(auto|manual)$")


class BrowserScanPayload(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    barcode: str = Field(min_length=1, max_length=256)
    checkpoint_id: str = Field(alias="checkpointId", min_length=1)
    selected_hardware_ids: list[str] = Field(default_factory=list, alias="selectedHardwareIds")
    online: bool = True
    scan_type: str = Field("auto", alias="scanType", pattern="^(auto|manual)$")
    direction: Optional[str] = Field(None, pattern="^(entry|exit)$")


class ManualReviewPayload(BaseModel):
    barcode: str = Field(min_length=1, max_length=256, strip_whitespace=True)
    checkpoint_id: str = Field(alias="checkpointId", min_length=1, max_length=128)


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

class PermissionRequestCreate(BaseModel):
    subject_id: str
    checkpoint_id: str
    request_type: str = Field(..., description="'manual_override' or 'zone_access'")
    reason: str

class PermissionDecision(BaseModel):
    decision: str = Field(..., pattern="^(approved|denied)$", description="'approved' or 'denied'")
    reason: Optional[str] = None
    admin_id: str
