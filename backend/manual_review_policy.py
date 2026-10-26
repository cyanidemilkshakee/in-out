"""Shared policy for human-reviewed terminal exceptions."""

import uuid

from facility_zones import normalize_facility_document

MANUAL_REVIEW_TIMEOUT_MINUTES = 10

_METADATA_ACCESS_FIELDS = ("status", "allowedZones", "allowedZone", "validFrom", "validTo", "validUntil",
                           "ownerId", "assignedEmployeeId")
_PERMISSION_ACCESS_FIELDS = ("state", "zones", "validFrom", "validTo")


def _access_fields(data, fields):
    normalized = normalize_facility_document(data or {})
    return {field: normalized.get(field) for field in fields}


def revised_access_data(previous, current, *, permission=False, force=False):
    """Advance a server-owned revision only for access changes or a new grant.

    Persistent JSON revisions also detect change-then-revert. Legacy documents
    need no migration: the first real access change installs a revision, while
    cosmetic edits retain their existing revision (including an absent one).
    """
    previous, current = previous or {}, current or {}
    fields = _PERMISSION_ACCESS_FIELDS if permission else _METADATA_ACCESS_FIELDS
    changed = _access_fields(previous, fields) != _access_fields(current, fields)
    if not permission:
        changed = changed or ("category" in previous) != ("category" in current)
    result = dict(current)
    revision = uuid.uuid4().hex if changed or force else previous.get("accessRevision")
    if revision is None:
        result.pop("accessRevision", None)
    else:
        result["accessRevision"] = revision
    return result


def manual_access_snapshot(subject, permission):
    """Only reviewed authorization and identity, independent of presence/names."""
    metadata = subject.hardware if subject.kind == "hardware" else subject.person
    data = metadata.data if metadata else {}
    return {
        "kind": subject.kind,
        "barcode": subject.barcode.casefold(),
        "metadata": {**_access_fields(data, _METADATA_ACCESS_FIELDS),
                     "accessRevision": (data or {}).get("accessRevision"),
                     "hasCategory": "category" in (data or {})},
        "permission": ({"id": permission.id,
                        **_access_fields(permission.data, _PERMISSION_ACCESS_FIELDS),
                        "accessRevision": (permission.data or {}).get("accessRevision")}
                       if permission else None),
    }
