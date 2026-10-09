import logging
import uuid
import secrets
import json
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from time import monotonic
from typing import AsyncIterator

from fastapi import FastAPI, Depends, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from auth import verify_admin_request, verify_authenticated_request, verify_terminal_operator_request
from config import settings
from database import get_db, get_read_db, engine, read_engine
from schemas import ScanPayload, ScanResponse
from terminal_scans import record_scan
from redis_client import get_redis_pool, close_redis_pool, publish_presence_update
from dashboard_cache import invalidate_dashboard_cache
from routers import presence, movements, registry, permissions
from routers import dashboard, alerts, notifications, audit, checkpoints, terminal, admin_profile
from temporal_worker import get_temporal_client

logger = logging.getLogger(__name__)
_write_windows: dict[str, deque[float]] = defaultdict(deque)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Manage only HTTP-process resources.

    Migrations/seeding, Temporal scheduling, and the worker run in dedicated
    services, so the API can be restarted and scaled independently.
    """
    get_redis_pool()

    yield

    await engine.dispose()
    await read_engine.dispose()
    await close_redis_pool()
    logger.info("All connection pools closed.")

async def verify_mtls_terminal(request: Request) -> str:
    """
    Validate the mTLS terminal identity forwarded by the API Gateway.

    In production, the API Gateway (Nginx/Envoy) terminates TLS and forwards:
      X-Client-Verify: SUCCESS | FAILED | NONE
      X-Client-DN:     CN=terminal-abc,O=acme-corp

    SECURITY: The API Gateway MUST strip these headers from inbound external
    requests before forwarding. They must only be set by the Gateway itself.
    The gateway must also inject the configured shared proxy secret.
    """
    verify = request.headers.get("X-Client-Verify", "NONE")
    client_dn = request.headers.get("X-Client-DN", "")

    if not settings.MTLS_PROXY_SECRET or not secrets.compare_digest(
        request.headers.get("X-Proxy-Secret", ""), settings.MTLS_PROXY_SECRET
    ):
        raise HTTPException(status_code=401, detail="Trusted certificate gateway required")

    if verify != "SUCCESS":
        raise HTTPException(status_code=401, detail="mTLS client certificate required or invalid")

    if not client_dn:
        raise HTTPException(status_code=401, detail="Client DN header missing")

    return client_dn


app = FastAPI(title="InOut Backend", lifespan=lifespan)


@app.middleware("http")
async def protect_write_requests(request: Request, call_next):
    """Reject unbounded commands and limit write bursts before body parsing.

    This is a process-local backstop. A public deployment should apply the
    equivalent limit at its trusted reverse proxy as well.
    """
    is_write = request.method in {"POST", "PUT", "PATCH", "DELETE"}
    content_length = request.headers.get("content-length")
    if is_write:
        # Do not let chunked or otherwise unbounded requests reach FastAPI's
        # JSON parser. The gateway is responsible for buffering such requests
        # and supplying a verified Content-Length when it forwards them.
        if content_length is None or not content_length.isdecimal():
            return JSONResponse(status_code=411, content={"detail": "A bounded Content-Length is required"})
        if int(content_length) > settings.MAX_REQUEST_BODY_BYTES:
            return JSONResponse(status_code=413, content={"detail": "Request payload is too large"})

    if is_write:
        client = request.client.host if request.client else "unknown"
        now = monotonic()
        window = _write_windows[client]
        while window and now - window[0] >= 60:
            window.popleft()
        if len(window) >= settings.WRITE_RATE_LIMIT_PER_MINUTE:
            return JSONResponse(status_code=429, content={"detail": "Too many write requests; try again shortly"})
        window.append(now)
    return await call_next(request)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(presence.router, dependencies=[Depends(verify_authenticated_request)])
app.include_router(movements.router, dependencies=[Depends(verify_admin_request)])
app.include_router(registry.router)
app.include_router(registry.bundle_router, dependencies=[Depends(verify_admin_request)])
app.include_router(permissions.router)

# Phase 2 — new routers
app.include_router(dashboard.router, dependencies=[Depends(verify_admin_request)])
app.include_router(alerts.router, dependencies=[Depends(verify_admin_request)])
app.include_router(notifications.router, dependencies=[Depends(verify_admin_request)])
app.include_router(audit.router, dependencies=[Depends(verify_admin_request)])
app.include_router(checkpoints.router, dependencies=[Depends(verify_admin_request)])
app.include_router(terminal.router, dependencies=[Depends(verify_terminal_operator_request)])
app.include_router(admin_profile.router, dependencies=[Depends(verify_admin_request)])


@app.get("/", include_in_schema=False)
async def api_root() -> dict:
    """Return a lightweight response for direct API root requests."""
    return {"service": "InOut Backend", "status": "ok", "health": "/health/live"}


@app.post("/v1/scans", response_model=ScanResponse)
async def process_scan(
    payload: ScanPayload,
    idempotency_key: uuid.UUID = Header(alias="Idempotency-Key"),
    db: AsyncSession = Depends(get_db),
    terminal_dn: str = Depends(verify_mtls_terminal),
) -> ScanResponse:
    """
    Critical path: process a terminal barcode scan.

    Requires the Idempotency-Key header (UUIDv4 minted by the terminal).
    Terminals can safely retry on network failure — duplicate keys return
    the cached response without mutating state.
    """
    cert_terminal_id = next(
        (part.split("=", 1)[1] for part in terminal_dn.split(",") if part.strip().startswith("CN=")),
        terminal_dn,
    )

    if payload.terminal_id != cert_terminal_id:
        logger.warning(
            "terminal_id mismatch: cert=%s body=%s", cert_terminal_id, payload.terminal_id
        )
        raise HTTPException(
            status_code=403,
            detail="terminal_id in request body does not match authenticated certificate CN",
        )

    try:
        raw_response = await record_scan(db, idempotency_key, payload, payload.terminal_id)
        response = ScanResponse(**raw_response)
        await db.commit()
        await invalidate_dashboard_cache()
        try:
            await publish_presence_update(json.dumps({
                "type": "scan",
                "subject_id": response.subject_id,
                "state": ("inside" if payload.direction == "entry" else "outside") if response.allowed else None,
                "movement": raw_response["decision"]["event"],
                "people": raw_response.get("updatedPeople", []),
                "hardwareAssets": raw_response.get("updatedHardwareAssets", []),
            }))
        except Exception:
            logger.exception("Presence publication failed after scan commit")
        return response
    except HTTPException:
        await db.rollback()
        raise
    except Exception:
        await db.rollback()
        logger.exception("Unhandled error during scan processing")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.get("/health/live")
async def health_live() -> dict:
    """Kubernetes liveness probe — always returns 200 if the process is alive."""
    return {"status": "ok"}


@app.get("/health/ready")
async def health_ready(db: AsyncSession = Depends(get_read_db)) -> dict:
    """Readiness probe for the API's required data and event dependencies."""
    try:
        from sqlalchemy import text
        await db.execute(text("SELECT 1"))
        await get_redis_pool().ping()
        temporal_client = await get_temporal_client()
        from temporalio.api.workflowservice.v1 import GetClusterInfoRequest
        await temporal_client.workflow_service.get_cluster_info(GetClusterInfoRequest())
        return {
            "status": "ready",
            "dependencies": {"database": "ready", "redis": "ready", "temporal": "ready"},
        }
    except Exception:
        logger.exception("Readiness check failed")
        raise HTTPException(status_code=503, detail="Required dependency unavailable")
