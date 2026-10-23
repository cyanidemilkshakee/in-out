import logging
import asyncio
import uuid
import secrets
import json
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Depends, Header, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from api_errors import database_timeout_error, install_api_error_handlers
from auth import verify_admin_request, verify_authenticated_request, verify_terminal_access_request, verify_gateway_rate_identity
from config import settings
from request_admission import RequestAdmissionMiddleware
from request_observability import RequestObservabilityMiddleware, configure_request_logging
from behavior_limits import enforce_behavior_admission
from data_limits import DataLimitsMiddleware
from database import get_db, get_read_db, engine, read_engine, is_database_timeout, rollback_after_error
from keycloak_http import close_keycloak_admin_client
from schemas import ScanPayload, ScanResponse
from terminal_scans import record_scan
from event_outbox import enqueue_presence
from terminal_assignments import require_checkpoint
from redis_client import get_redis_pool, close_redis_pool, publish_presence_update
from routers import presence, movements, registry, permissions
from routers import dashboard, alerts, audit, checkpoints, terminal, admin_profile, keycloak_admin
from routers import user_management_auth, exports
from temporal_worker import get_temporal_client, close_temporal_client

logger = logging.getLogger(__name__)
_READINESS_TIMEOUT_SECONDS = 4.0  # Complete before the Compose probe's five-second deadline.



@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Manage only HTTP-process resources.

    Migrations/seeding, Temporal scheduling, and the worker run in dedicated
    services, so the API can be restarted and scaled independently.
    """
    get_redis_pool()

    yield

    await close_keycloak_admin_client()
    await engine.dispose()
    await read_engine.dispose()
    await close_redis_pool()
    await close_temporal_client()
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

    identity = "terminal:" + client_dn
    state = request.scope.setdefault("state", {})
    state["limit_identity"] = identity
    state["limit_actor"] = client_dn
    await enforce_behavior_admission(request, identity)
    return client_dn


app = FastAPI(title="InOut Backend", lifespan=lifespan)
install_api_error_handlers(app)


app.add_middleware(RequestAdmissionMiddleware)
# Outer response guard sees the identity selected by authenticated dependencies.
app.add_middleware(DataLimitsMiddleware)
configure_request_logging()
app.add_middleware(RequestObservabilityMiddleware)

app.include_router(presence.router, dependencies=[Depends(verify_authenticated_request)])
app.include_router(user_management_auth.router)
app.include_router(movements.router, dependencies=[Depends(verify_admin_request)])
app.include_router(registry.router)
app.include_router(registry.bundle_router, dependencies=[Depends(verify_admin_request)])
app.include_router(permissions.router)

# Phase 2 — new routers
app.include_router(dashboard.router, dependencies=[Depends(verify_admin_request)])
app.include_router(alerts.router, dependencies=[Depends(verify_admin_request)])
app.include_router(audit.router, dependencies=[Depends(verify_admin_request)])
app.include_router(checkpoints.router, dependencies=[Depends(verify_admin_request)])
app.include_router(keycloak_admin.router)
app.include_router(terminal.router, dependencies=[Depends(verify_terminal_access_request)])
app.include_router(admin_profile.router, dependencies=[Depends(verify_admin_request)])
app.include_router(exports.router)


@app.post("/internal/gateway/identity", include_in_schema=False)
async def gateway_rate_identity(request: Request) -> dict:
    """Private callback used before Kong's authenticated account rate limit."""
    return await verify_gateway_rate_identity(request)


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
    request: Request = None,
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
        await require_checkpoint(db, "mtls:" + cert_terminal_id, payload.checkpoint_id)
        scan_options = {"request_scope": request.scope} if request is not None else {}
        raw_response = await record_scan(db, idempotency_key, payload, payload.terminal_id, **scan_options)
        response = ScanResponse(**raw_response)
        if not db.info.get("scan_replayed"):
            await enqueue_presence(db, {
                "type": "scan",
                "subject_id": response.subject_id,
                "state": ("inside" if raw_response["decision"]["event"]["direction"] == "entry" else "outside") if response.allowed else None,
                "movement": raw_response["decision"]["event"],
                "alerts": db.info.get("scan_alerts", []),
                "people": raw_response.get("updatedPeople", []),
                "hardwareAssets": raw_response.get("updatedHardwareAssets", []),
            })
        await db.commit()
        return response
    except HTTPException:
        await rollback_after_error(db)
        raise
    except Exception as error:
        await rollback_after_error(db)
        context = {"exception_type": type(error).__name__,
            "request_id": request.scope.get("state", {}).get("request_id") if request is not None else None}
        if is_database_timeout(error):
            logger.warning("Database scan request timed out", extra=context)
            raise database_timeout_error() from None
        logger.error("Unhandled error during scan processing", extra=context)
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
        async with asyncio.timeout(_READINESS_TIMEOUT_SECONDS):
            await db.execute(text("SELECT 1"))
            await get_redis_pool().ping()
            temporal_client = await get_temporal_client()
            from datetime import timedelta
            from temporalio.api.workflowservice.v1 import GetClusterInfoRequest
            await temporal_client.workflow_service.get_cluster_info(
                GetClusterInfoRequest(), timeout=timedelta(seconds=2))
        return {
            "status": "ready",
            "dependencies": {"database": "ready", "redis": "ready", "temporal": "ready"},
        }
    except Exception:
        logger.exception("Readiness check failed")
        raise HTTPException(status_code=503, detail="Required dependency unavailable")
