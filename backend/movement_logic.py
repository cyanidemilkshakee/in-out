"""
movement_logic.py
-----------------
Python port of lib/movementLogic.ts.

Public API
----------
evaluate_scan(...)       -> ScanDecision
denial_code_for_reason(reason: str) -> str
find_subject(...)        -> Person | HardwareAsset | None
apply_movement_state(...)-> dict
"""

from __future__ import annotations

from datetime import datetime, timezone, timedelta
from typing import Any, Literal, TypedDict

# ---------------------------------------------------------------------------
# TypedDicts (mirror of types.ts)
# ---------------------------------------------------------------------------

Direction = Literal["entry", "exit"]
ResultStatus = Literal["approved", "denied"]
SyncState = Literal["synced", "queued", "conflict"]
SubjectType = Literal["employee", "visitor", "hardware"]
ScanType = Literal["auto", "manual"]

DenialCode = Literal[
    "barcode_not_registered",
    "asset_restricted",
    "access_restricted",
    "access_inactive",
    "expired_pass",
    "approval_pending",
    "not_preapproved",
    "hardware_restricted",
    "custody_mismatch",
    "zone_not_permitted",
    "already_inside",
    "no_active_entry",
    "asset_not_expected_out",
    "manual_review",
]


class Person(TypedDict, total=False):
    id: str
    name: str
    type: Literal["employee", "visitor"]
    barcode: str
    department: str
    company: str
    phone: str
    accessLevel: str
    allowedZones: list[str]
    status: Literal["active", "inactive", "pre_approved", "pending_approval", "restricted", "expired"]
    host: str
    purpose: str
    validFrom: str
    validTo: str
    inside: bool
    createdAt: str


class HardwareAsset(TypedDict, total=False):
    id: str
    name: str
    barcode: str
    owner: str
    assignedEmployeeId: str
    assignedEmployeeName: str
    category: str
    allowedZones: list[str]
    status: Literal["active", "restricted", "maintenance"]
    inside: bool
    createdAt: str


class Checkpoint(TypedDict, total=False):
    id: str
    name: str
    mode: Literal["auto", "manual", "entry", "exit"]
    zone: str
    online: bool
    createdAt: str


class MovementEvent(TypedDict, total=False):
    id: str
    date: str
    time: str
    checkpointId: str
    checkpoint: str
    direction: Direction
    subjectId: str
    subjectName: str
    subjectType: SubjectType
    barcode: str
    result: ResultStatus
    reason: str
    denialCode: DenialCode
    scanType: ScanType
    syncState: SyncState
    hardwareIds: list[str]
    createdAt: str


class ScanDecision(TypedDict):
    event: MovementEvent
    subject: Any  # Person | HardwareAsset | None
    carriedHardware: list[HardwareAsset]


# ---------------------------------------------------------------------------
# IST helpers (Asia/Kolkata = UTC+05:30)
# ---------------------------------------------------------------------------

_IST = timezone(timedelta(hours=5, minutes=30))

_MONTH_ABBR = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]


def _current_date(dt: datetime) -> str:
    """Return date formatted as en-US short: e.g. 'Sep 8, 2026'"""
    ist = dt.astimezone(_IST)
    return f"{_MONTH_ABBR[ist.month - 1]} {ist.day}, {ist.year}"


def _current_time(dt: datetime) -> str:
    """Return time formatted as en-US numeric with AM/PM: e.g. '1:44:38 PM'"""
    ist = dt.astimezone(_IST)
    hour12 = ist.hour % 12 or 12
    ampm = "AM" if ist.hour < 12 else "PM"
    return f"{hour12}:{ist.minute:02d}:{ist.second:02d} {ampm}"


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _is_hardware(subject: Any) -> bool:
    """True when subject has a 'category' key — mirrors TypeScript isHardware()."""
    return "category" in subject


def _zone_allowed(subject: Any, checkpoint: Checkpoint) -> bool:
    allowed: list[str] = subject.get("allowedZones", [])
    if "All Zones" in allowed:
        return True
    return checkpoint.get("zone", "") in allowed or checkpoint.get("name", "") in allowed


def _direction_for(checkpoint: Checkpoint, subject: Any | None) -> Direction:
    mode = checkpoint.get("mode", "")
    if mode == "entry":
        return "entry"
    if mode == "exit":
        return "exit"
    # auto / manual mode -> derive from current inside state
    return "exit" if (subject and subject.get("inside")) else "entry"


def _status_for(
    subject: Any | None,
    checkpoint: Checkpoint,
    direction: Direction,
    carried_hardware: list[HardwareAsset],
    now: datetime,
) -> dict[str, str]:
    """
    Core access decision logic — mirrors statusFor() in movementLogic.ts.
    Returns {"result": "approved"|"denied", "reason": str}.
    """
    if subject is None:
        return {"result": "denied", "reason": "Barcode not registered"}

    # The administrator admitted this visit despite the entry policy. Honour
    # its matching exit even if that policy still denies entry or has expired.
    # Extra assets do not inherit another visit's manual approval.
    override = subject.get("entryOverride")
    if direction == "exit" and subject.get("inside") and isinstance(override, dict) and override.get("requestId"):
        admitted_assets = set(override.get("hardwareIds") or [])
        if all(asset.get("inside") and asset.get("id") in admitted_assets for asset in carried_hardware):
            return {"result": "approved", "reason": "Exit for manually approved entry"}

    for field, label, predicate in (
        ("validFrom", "Access pass is not active yet", lambda value: now < value),
        ("validTo", "Access pass has expired", lambda value: now > value),
    ):
        raw_value = subject.get(field)
        if not raw_value:
            continue
        try:
            parsed = datetime.fromisoformat(str(raw_value).replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=_IST)
            if predicate(parsed):
                return {"result": "denied", "reason": label}
        except (TypeError, ValueError):
            return {"result": "denied", "reason": "Access pass has an invalid validity window"}

    # Hardware-specific restrictions
    if _is_hardware(subject) and subject.get("status") != "active":
        return {"result": "denied", "reason": f"Asset {subject.get('status') or 'inactive'}"}

    # Employee-specific restrictions
    if not _is_hardware(subject) and subject.get("type") == "employee":
        if subject.get("status") == "restricted":
            return {"result": "denied", "reason": "Employee access restricted"}
        if subject.get("status") != "active":
            return {"result": "denied", "reason": f"Employee access {subject.get('status') or 'inactive'}"}

    # Visitor-specific checks
    if not _is_hardware(subject) and subject.get("type") == "visitor":
        if subject.get("status") == "expired":
            return {"result": "denied", "reason": "Temporary barcode expired"}
        if subject.get("status") != "pre_approved":
            reason = (
                "Temporary visitor approval pending"
                if subject.get("status") == "pending_approval"
                else "Not pre-approved"
            )
            return {"result": "denied", "reason": reason}

    # Carried hardware restrictions (any non-active asset)
    restricted_hw = next(
        (a for a in carried_hardware if a.get("status") != "active"), None
    )
    if restricted_hw:
        return {
            "result": "denied",
            "reason": f"{restricted_hw['name']} is {restricted_hw['status']}",
        }

    # Custody mismatch (only when scanning a person)
    if not _is_hardware(subject):
        custody_mismatch = next(
            (
                a
                for a in carried_hardware
                if a.get("assignedEmployeeId")
                and a.get("assignedEmployeeId") != subject.get("id")
            ),
            None,
        )
        if custody_mismatch:
            assignee = custody_mismatch.get("assignedEmployeeName") or "another employee"
            return {
                "result": "denied",
                "reason": (
                    f"Hardware assigned to {assignee}; custody approval required"
                ),
            }

    # Carried assets obey the same validity, zone and presence rules as a
    # direct asset scan; selecting a carrier must not bypass asset controls.
    for asset in carried_hardware:
        asset_decision = _status_for(asset, checkpoint, direction, [], now)
        if asset_decision["result"] == "denied":
            return asset_decision

    # Zone check
    if not _zone_allowed(subject, checkpoint):
        return {"result": "denied", "reason": "Checkpoint zone not permitted"}

    # Already-inside / no-active-entry
    if direction == "entry" and subject.get("inside"):
        return {"result": "denied", "reason": "Already inside"}
    if direction == "exit" and not subject.get("inside"):
        return {"result": "denied", "reason": "No active entry found"}

    # Warehouse-specific hardware exit block
    if _is_hardware(subject) and direction == "exit" and checkpoint.get("id") == "cp-warehouse":
        return {"result": "denied", "reason": "Asset not expected out"}

    return {"result": "approved", "reason": "-"}


# ---------------------------------------------------------------------------
# Public functions
# ---------------------------------------------------------------------------

def denial_code_for_reason(reason: str | None = None) -> str:
    """
    Maps a human-readable denial reason to a DenialCode string.
    Port of denialCodeForReason() in movementLogic.ts.
    """
    normalized = (reason or "").lower()
    if "not registered" in normalized:
        return "barcode_not_registered"
    if "temporary barcode expired" in normalized:
        return "expired_pass"
    if "approval pending" in normalized:
        return "approval_pending"
    if "not pre-approved" in normalized:
        return "not_preapproved"
    if "assigned to" in normalized:
        return "custody_mismatch"
    if "checkpoint zone" in normalized:
        return "zone_not_permitted"
    if "already inside" in normalized:
        return "already_inside"
    if "no active entry" in normalized:
        return "no_active_entry"
    if "not expected out" in normalized:
        return "asset_not_expected_out"
    if "asset restricted" in normalized:
        return "asset_restricted"
    if "hardware" in normalized and "restricted" in normalized:
        return "hardware_restricted"
    if "employee access restricted" in normalized:
        return "access_restricted"
    if "employee access inactive" in normalized:
        return "access_inactive"
    return "manual_review"


def find_subject(
    barcode: str,
    people: list[Person],
    hardware: list[HardwareAsset],
) -> Any | None:
    """
    Locate a subject by barcode (case-insensitive, trimmed).
    People take priority over hardware assets, matching findSubject() in TS.
    """
    normalized = barcode.strip().lower()
    for person in people:
        if person.get("barcode", "").lower() == normalized:
            return person
    for asset in hardware:
        if asset.get("barcode", "").lower() == normalized:
            return asset
    return None


def evaluate_scan(
    *,
    barcode: str,
    checkpoint: Checkpoint,
    people: list[Person],
    hardware: list[HardwareAsset],
    selected_hardware_ids: list[str],
    online: bool,
    event_count: int,
    scan_type: ScanType,
    event_id: str | None = None,
) -> ScanDecision:
    """
    Core scan evaluation — port of evaluateScan() in movementLogic.ts.

    Parameters
    ----------
    barcode              : raw barcode string from the scanner
    checkpoint           : the Checkpoint being scanned at
    people               : full person registry
    hardware             : full hardware-asset registry
    selected_hardware_ids: IDs of hardware the person claims to carry
    online               : whether the terminal is connected to the server
    event_count          : used to generate a deterministic event ID
    scan_type            : "auto" | "manual"
    event_id             : optional caller-provided event ID for persisted scans

    Returns
    -------
    ScanDecision dict with keys: event, subject, carriedHardware
    """
    now = datetime.now(tz=timezone.utc)

    subject = find_subject(barcode, people, hardware)
    direction = _direction_for(checkpoint, subject)
    carried_hardware: list[HardwareAsset] = [
        a for a in hardware if a.get("id") in selected_hardware_ids
    ]
    decision = _status_for(subject, checkpoint, direction, carried_hardware, now)

    sync_state: SyncState = "synced" if online else "queued"

    # Offline callers retain deterministic EVT IDs; persisted server scans can
    # provide their UUID directly so it is not generated and then discarded.
    if event_id is None:
        raw_num = 1000 + event_count
        event_id = f"EVT-{str(raw_num).zfill(6)}"

    event: MovementEvent = {
        "id": event_id,
        "date": _current_date(now),
        "time": _current_time(now),
        "checkpointId": checkpoint.get("id", ""),
        "checkpoint": checkpoint.get("name", ""),
        "direction": direction,
        "subjectId": subject.get("id", "unknown") if subject else "unknown",
        "subjectName": subject.get("name", "Unknown barcode") if subject else "Unknown barcode",
        "subjectType": (
            "hardware" if (subject and _is_hardware(subject))
            else (subject.get("type", "visitor") if subject else "visitor")
        ),
        "barcode": barcode.strip(),
        "result": decision["result"],
        "reason": decision["reason"],
        "scanType": scan_type,
        "syncState": sync_state,
        "hardwareIds": [a.get("id", "") for a in carried_hardware],
        "createdAt": now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z",
    }

    # Only attach denialCode when the result is denied
    if decision["result"] == "denied":
        event["denialCode"] = denial_code_for_reason(decision["reason"])

    return ScanDecision(event=event, subject=subject, carriedHardware=carried_hardware)


def apply_movement_state(
    event: MovementEvent,
    people: list[Person],
    hardware: list[HardwareAsset],
) -> dict[str, list]:
    """
    Apply the side-effects of an approved movement event to registry copies.
    Port of applyMovementState() in movementLogic.ts.

    Returns a new dict {"people": [...], "hardware": [...]} -- does NOT mutate
    the input lists.
    """
    if event.get("result") != "approved":
        return {"people": list(people), "hardware": list(hardware)}

    inside = event.get("direction") == "entry"
    subject_id = event.get("subjectId")
    hardware_ids: list[str] = event.get("hardwareIds", [])

    updated_people = [
        {**p, "inside": inside} if p.get("id") == subject_id else dict(p)
        for p in people
    ]
    updated_hardware = [
        {**a, "inside": inside}
        if (a.get("id") == subject_id or a.get("id") in hardware_ids)
        else dict(a)
        for a in hardware
    ]

    return {"people": updated_people, "hardware": updated_hardware}
