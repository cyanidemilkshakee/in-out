"""Record one security audit event per identity and cooldown, without secrets."""
import asyncio
import hashlib
import json
import logging
import uuid
from datetime import datetime, timezone

from database import AsyncSessionLocal
from models import AuditEvent
from redis_client import get_redis_pool

logger = logging.getLogger(__name__)


async def record_limit_event(scope, kind, retry_after, details=None):
    state = scope.get("state", {})
    identity = state.get("limit_identity")
    if not identity:
        return
    duration = max(1, int(retry_after))
    digest = hashlib.sha256(identity.encode()).hexdigest()
    kind_digest = hashlib.sha256(kind.encode()).hexdigest()[:16]
    try:
        first = await get_redis_pool().set(
            f"inout:security-limits:audit:{digest}:{kind_digest}", "1", nx=True, ex=duration,
        )
    except Exception:
        # Quota-store outages must not turn every rejection into another DB job.
        logger.warning("Security limit event: %s", json.dumps({
            "kind": kind, "identityHash": digest, "retryAfter": duration,
            "auditStore": "quota_unavailable",
        }))
        return
    if not first:
        return
    now = datetime.now(timezone.utc)
    route = scope.get("route")
    route_path = getattr(route, "path", None)
    # Unknown routes have no trusted template; never log caller query/body data.
    data = {
        "category": "security", "action": "request_throttled",
        "subjectId": "", "subjectName": "Request protection",
        "actor": state.get("limit_actor", digest), "role": "system",
        "reason": f"{kind.replace('_', ' ')}; retry after {duration} seconds.",
        "relatedId": "", "createdAt": now.isoformat(),
        "date": now.date().isoformat(), "time": now.strftime("%H:%M:%S"),
        "limitKind": kind, "retryAfter": duration,
        "method": scope.get("method", ""), "route": route_path or "unknown",
        "details": details or {},
    }
    event_id = str(uuid.uuid4())
    logger.warning("Security limit event: %s", json.dumps({"id": event_id, **data}))
    try:
        async with asyncio.timeout(2):
            async with AsyncSessionLocal() as db:
                db.add(AuditEvent(id=event_id, created_at=now, data=data))
                await db.commit()
    except Exception as error:
        # The structured application log remains the fallback audit evidence.
        logger.error("Security audit persistence failed: event=%s error=%s",
                     event_id, type(error).__name__)
