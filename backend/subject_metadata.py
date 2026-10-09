"""Current employee metadata, independent of retained history snapshots."""
from typing import Any


def current_subject_metadata(kind: str | None, data: dict[str, Any] | None) -> dict[str, Any]:
    """Discard retired descriptive employee fields using the relational kind."""
    current = dict(data or {})
    if kind == "employee":
        current.pop("department", None)
        current.pop("accessLevel", None)
    return current
