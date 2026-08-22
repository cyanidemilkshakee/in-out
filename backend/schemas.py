from pydantic import BaseModel, Field
from typing import Optional
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
