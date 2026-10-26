"""Consistent FastAPI error envelopes with the legacy ``detail`` preserved."""
from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import JSONResponse
from database import is_database_timeout

logger = logging.getLogger(__name__)


def database_timeout_error():
    return HTTPException(503, detail={"code": "database_timeout",
        "message": "Database request timed out. Retry the request."}, headers={"Retry-After": "1"})

_STATUS_CODES = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    408: "request_timeout",
    409: "conflict",
    413: "payload_too_large",
    415: "unsupported_media_type",
    422: "unprocessable_entity",
    429: "rate_limited",
    499: "client_closed_request",
    502: "bad_gateway",
    503: "service_unavailable",
    504: "upstream_timeout",
}


def error_body(
    status_code: int,
    detail: Any,
    *,
    code: str | None = None,
    message: str | None = None,
    details: Any = None,
) -> dict[str, Any]:
    """Build an additive error contract without changing the existing detail value."""
    legacy_detail = detail
    if isinstance(detail, dict):
        code = code or (detail.get("code") if isinstance(detail.get("code"), str) else None)
        message = message or (detail.get("message") if isinstance(detail.get("message"), str) else None)
        if details is None:
            details = detail.get("details")
            if details is None:
                remaining = {key: value for key, value in detail.items() if key not in {"code", "message"}}
                details = remaining or None
    elif isinstance(detail, str):
        message = message or detail
    elif detail is not None:
        details = detail if details is None else details

    default_code = _STATUS_CODES.get(
        status_code, "internal_error" if status_code >= 500 else "http_error"
    )

    error: dict[str, Any] = {
        "code": code or default_code,
        "message": message or "Request failed",
    }
    if details is not None:
        error["details"] = details
    return jsonable_encoder({"detail": legacy_detail, "error": error})


def _safe_validation_details(errors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Do not duplicate submitted values (which may include secrets) into the new envelope."""
    return [
        {
            "location": jsonable_encoder(error.get("loc", [])),
            "message": str(error.get("msg", "Invalid value")),
            "type": str(error.get("type", "validation_error")),
        }
        for error in errors
    ]


def install_api_error_handlers(app: FastAPI) -> None:
    """Install the common error envelope for framework and application failures."""

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        del request
        return JSONResponse(
            error_body(exc.status_code, exc.detail),
            status_code=exc.status_code,
            headers=exc.headers,
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        del request
        errors = exc.errors()
        return JSONResponse(
            error_body(
                422,
                jsonable_encoder(errors),
                code="request_validation_error",
                message="Request validation failed",
                details=_safe_validation_details(errors),
            ),
            status_code=422,
        )

    @app.exception_handler(Exception)
    async def handle_unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        request_id = request.scope.get("state", {}).get("request_id")
        if is_database_timeout(exc):
            logger.warning("Database request timed out", extra={"method": request.method,
                "exception_type": type(exc).__name__, "request_id": request_id})
            error = database_timeout_error()
            return JSONResponse(error_body(error.status_code, error.detail), status_code=error.status_code,
                headers={**error.headers, **({"X-Request-ID": request_id} if isinstance(request_id, str) else {})})
        logger.error(
            "Unhandled API exception",
            extra={"method": request.method, "exception_type": type(exc).__name__, "request_id": request_id},
        )
        return JSONResponse(
            error_body(500, "Internal server error", code="internal_error", message="Internal server error"),
            status_code=500,
            headers={"X-Request-ID": request_id} if isinstance(request_id, str) else None,
        )
