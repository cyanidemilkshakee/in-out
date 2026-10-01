import logging
import uuid
import secrets
import json
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Depends, Header, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from auth import verify_admin_request, verify_authenticated_request, verify_terminal_access_request
from config import settings
from request_limits import RequestLimitsMiddleware
from database import get_db, get_read_db, engine, read_engine
from schemas import ScanPayload, ScanResponse
from terminal_scans import record_scan
from redis_client import get_redis_pool, close_redis_pool, publish_presence_update
from dashboard_cache import invalidate_dashboard_cache
from routers import presence, movements, registry, permissions
from routers import dashboard, alerts, notifications, audit, checkpoints, terminal, admin_profile, keycloak_admin
from temporal_worker import get_temporal_client

logger = logging.getLogger(__name__)



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

    Kong verifies the client certificate on its dedicated TLS listener, strips
    caller-supplied identity headers, and injects the certificate subject and
    a shared secret. The API is not published directly by Docker Compose.
    """
    client_dn = request.headers.get("X-Inout-Terminal-DN", "")

    if len(settings.KONG_TERMINAL_SECRET) < 32 or not secrets.compare_digest(
        request.headers.get("X-Inout-Gateway-Secret", ""), settings.KONG_TERMINAL_SECRET
    ):
        raise HTTPException(status_code=401, detail="Trusted Kong terminal identity required")

    if not client_dn:
        raise HTTPException(status_code=401, detail="Verified terminal identity missing")

    return client_dn


app = FastAPI(title="InOut Backend", lifespan=lifespan)


app.add_middleware(RequestLimitsMiddleware)

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
app.include_router(keycloak_admin.router)
app.include_router(terminal.router, dependencies=[Depends(verify_terminal_access_request)])
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
        if db.info.get("scan_replayed"):
            return response
        await invalidate_dashboard_cache()
        try:
            await publish_presence_update(json.dumps({
                "type": "scan",
                "subject_id": response.subject_id,
                "state": ("inside" if raw_response["decision"]["event"]["direction"] == "entry" else "outside") if response.allowed else None,
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
