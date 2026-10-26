"""Browser and certificate scan routes expose safe retryable DB timeout errors."""
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
from fastapi import FastAPI
from sqlalchemy.exc import DBAPIError

from api_errors import install_api_error_handlers
from auth import verify_terminal_access_request
from database import get_db
import main
from routers import terminal


class DriverTimeout(Exception):
    sqlstate = "57014"


class DatabaseTimeoutHTTPTests(unittest.IsolatedAsyncioTestCase):
    async def test_both_scan_transports_map_timeout_without_logging_sql_or_secrets(self):
        for certificate in (False, True):
            with self.subTest(certificate=certificate):
                app = FastAPI()
                install_api_error_handlers(app)
                app.include_router(terminal.router)
                app.post("/v1/scans")(main.process_scan)
                request_id = str(uuid.uuid4())

                @app.middleware("http")
                async def trusted_context(request, call_next):
                    request.scope.setdefault("state", {})["request_id"] = request_id
                    response = await call_next(request)
                    response.headers["X-Request-ID"] = request_id
                    return response

                db = SimpleNamespace(get=AsyncMock(return_value=SimpleNamespace(data={"mode": "auto"})),
                    rollback=AsyncMock(), commit=AsyncMock())

                async def session():
                    yield db

                app.dependency_overrides[get_db] = session
                app.dependency_overrides[verify_terminal_access_request] = lambda: {"sub": "operator"}
                failure = DBAPIError("secret-sql", {"token": "secret-parameter"}, DriverTimeout("secret-provider"))
                namespace = "main" if certificate else "routers.terminal"
                gateway_proof = "synthetic-gateway-proof-at-least-32-characters"
                headers = {"Idempotency-Key": str(uuid.uuid4())}
                if certificate:
                    headers.update({"X-Inout-Terminal-DN": "CN=test-terminal", "X-Inout-Gateway-Secret": gateway_proof})
                payload = ({"barcode": "p1", "terminal_id": "test-terminal", "checkpoint_id": "cp-main",
                            "direction": "entry"} if certificate else {"barcode": "p1", "checkpointId": "cp-main"})
                with patch(namespace + ".require_checkpoint", new=AsyncMock(return_value="cp-main")), \
                     patch(namespace + ".record_scan", new=AsyncMock(side_effect=failure)), \
                     patch.object(main.settings, "KONG_TERMINAL_SECRET", gateway_proof), \
                     patch("main.enforce_behavior_admission", new=AsyncMock()), \
                     self.assertLogs("main" if certificate else "api_errors", level="WARNING") as captured:
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                                                base_url="http://test") as client:
                        response = await client.post("/v1/scans" if certificate else "/v1/terminal/scans",
                            json=payload, headers=headers)
                self.assertEqual(response.status_code, 503, response.text)
                self.assertEqual(response.json()["error"]["code"], "database_timeout")
                self.assertEqual(response.headers["Retry-After"], "1")
                self.assertEqual(response.headers["X-Request-ID"], request_id)
                self.assertNotIn("secret", response.text)
                self.assertEqual(captured.records[0].request_id, request_id)
                self.assertEqual(captured.records[0].exception_type, "DBAPIError")
                self.assertIsNone(captured.records[0].exc_info)
                self.assertNotIn("secret", repr(captured.records[0].__dict__))
                self.assertNotIn(gateway_proof, repr(captured.records[0].__dict__))
                db.commit.assert_not_awaited()
                if certificate:
                    db.rollback.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
