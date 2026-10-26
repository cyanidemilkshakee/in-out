"""Current subject metadata and bounded JSON documents."""
import json
from typing import Any

from fastapi import HTTPException

from config import settings


def validate_subject_metadata_size(data: dict[str, Any] | None) -> None:
    """Bound the complete compact UTF-8 JSON document without joining it.

    Iterative encoding visits one value at a time and stops once the budget is
    exceeded, so a large retained document needs no second full serialization.
    Count encoded bytes, including keys, escapes, and JSON structure, rather
    than characters. Unknown metadata remains supported within the budget.
    """
    maximum = settings.MAX_SUBJECT_METADATA_BYTES
    size = 0
    encoder = json.JSONEncoder(ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    try:
        for piece in encoder.iterencode(data or {}):
            # Individual JSON string tokens can be large; bound the temporary
            # UTF-8 byte buffer rather than encoding the whole token at once.
            for offset in range(0, len(piece), 4096):
                size += len(piece[offset:offset + 4096].encode("utf-8"))
                if size > maximum:
                    raise HTTPException(422, f"Subject metadata must be {maximum} bytes or fewer.")
    except (TypeError, ValueError, UnicodeError, RecursionError) as exc:
        raise HTTPException(422, "Subject metadata must contain valid JSON values with supported nesting.") from exc


def current_subject_metadata(kind: str | None, data: dict[str, Any] | None) -> dict[str, Any]:
    """Discard retired descriptive employee fields using the relational kind."""
    current = dict(data or {})
    if kind == "employee":
        current.pop("department", None)
        current.pop("accessLevel", None)
    return current
