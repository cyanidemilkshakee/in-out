import os
import asyncio
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Depends, Header, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from database import get_db, get_read_db, engine, read_engine
from schemas import ScanPayload, ScanResponse
from scan_service import ScanProcessingService
import logging
import uuid

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Manage startup and graceful shutdown of DB connection pools."""
    yield
    await engine.dispose()
    await read_engine.dispose()
    logger.info("Database connection pools closed.")


app = FastAPI(title="InOut Backend", lifespan=lifespan)


async def verify_mtls_terminal(request: Request) -> str:
    """
    Validate the mTLS terminal identity forwarded by the API Gateway.

    In production, the API Gateway (Nginx/Envoy) terminates TLS and forwards:
      X-Client-Verify: SUCCESS | FAILED | NONE
      X-Client-DN:     CN=terminal-abc,O=acme-corp

    SECURITY: The API Gateway MUST strip these headers from inbound external
    requests before forwarding. They must only be set by the Gateway itself.
    In development (ENV=dev) we skip the check to allow unproxied curl testing.
    """
    verify = request.headers.get("X-Client-Verify", "NONE")
    client_dn = request.headers.get("X-Client-DN", "")

    if verify != "SUCCESS":
        if settings.ENV == "dev":
            logger.warning("mTLS check bypassed — ENV=dev, no certificate presented.")
            return "CN=dev-terminal,O=local"
        raise HTTPException(status_code=401, detail="mTLS client certificate required or invalid")

    if not client_dn:
        raise HTTPException(status_code=401, detail="Client DN header missing")

    return client_dn


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

    service = ScanProcessingService(db)

    try:
        response = await service.process_scan(idempotency_key, payload)
        await db.commit()
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
    """Kubernetes readiness probe — checks the database is reachable."""
    try:
        from sqlalchemy import text
        await db.execute(text("SELECT 1"))
        return {"status": "ready"}
    except Exception:
        logger.exception("Readiness check failed")
        raise HTTPException(status_code=503, detail="Database unavailable")
