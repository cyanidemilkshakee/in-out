from pydantic import BaseModel, Field, ConfigDict
from typing import Optional
from datetime import datetime

BARCODE_PATTERN = r"^[A-Za-z0-9._:/-]+$"


class APIModel(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)


class ScanPayload(APIModel):
    barcode: str = Field(..., min_length=1, max_length=64, pattern=BARCODE_PATTERN)
    terminal_id: str = Field(..., min_length=1, max_length=128)
    checkpoint_id: str = Field(..., min_length=1, max_length=128)
    direction: str = Field(..., pattern="^(entry|exit)$")
    selected_hardware_ids: list[str] = Field(default_factory=list, max_length=8)
    online: bool = True
    scan_type: str = Field("auto", pattern="^(auto|manual)$")
    captured_offline_at: Optional[datetime] = None


class BrowserScanPayload(APIModel):
    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)
    barcode: str = Field(min_length=1, max_length=64, pattern=BARCODE_PATTERN)
    checkpoint_id: str = Field(alias="checkpointId", min_length=1, max_length=128)
    selected_hardware_ids: list[str] = Field(default_factory=list, alias="selectedHardwareIds", max_length=8)
    online: bool = True
    scan_type: str = Field("auto", alias="scanType", pattern="^(auto|manual)$")
    direction: Optional[str] = Field(None, pattern="^(entry|exit)$")
    captured_offline_at: Optional[datetime] = Field(None, alias="capturedOfflineAt")


class ManualReviewPayload(APIModel):
    barcode: str = Field(min_length=1, max_length=64, pattern=BARCODE_PATTERN)
    checkpoint_id: str = Field(alias="checkpointId", min_length=1, max_length=128)
    direction: Optional[str] = Field(None, pattern="^(entry|exit)$")
    event_id: Optional[str] = Field(None, alias="eventId", min_length=1, max_length=128)
    operator_note: str = Field(..., alias="operatorNote", min_length=1, max_length=1000)


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


# ── Phase 3 schemas ────────────────────────────────────────────────────────────

class SubjectCreate(APIModel):
    barcode: str = Field(..., min_length=1, max_length=64, pattern=BARCODE_PATTERN)
    kind: str = Field(..., pattern="^(employee|visitor|hardware)$")
    data: dict = Field(..., description="JSON metadata for the person or hardware")


class SubjectUpdate(APIModel):
    barcode: Optional[str] = Field(None, min_length=1, max_length=64, pattern=BARCODE_PATTERN)
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

class PermissionRequestCreate(APIModel):
    subject_id: str
    checkpoint_id: str
    request_type: str = Field(..., pattern="^(visitor|hardware_custody|manual_override|zone_access)$")
    reason: str
    subject_name: Optional[str] = None
    barcode: Optional[str] = Field(None, min_length=1, max_length=64, pattern=BARCODE_PATTERN)
    requester: Optional[str] = None
    requested_zones: list[str] = Field(default_factory=list)
    valid_from: Optional[str] = None
    valid_to: Optional[str] = None
    hardware_id: Optional[str] = None
    carrier_id: Optional[str] = None
    carrier_name: Optional[str] = None
    event_id: Optional[str] = None
    direction: Optional[str] = Field(None, pattern="^(entry|exit)$")
    operator_note: Optional[str] = Field(None, max_length=1000)

class PermissionDecision(APIModel):
    decision: str = Field(..., pattern="^(approved|denied)$", description="'approved' or 'denied'")
    reason: Optional[str] = Field(None, max_length=1000)
    valid_for_minutes: Optional[int] = Field(None, ge=15, le=240)
    admin_id: Optional[str] = None  # Legacy clients; the authenticated token owns attribution.
