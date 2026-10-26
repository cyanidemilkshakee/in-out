"""The HTTP error envelope is additive and keeps legacy detail clients working."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from api_errors import install_api_error_handlers
from config import settings
from request_admission import RequestAdmissionMiddleware

REQUEST_ID = "4db02688-3b58-4e78-8e23-1571ba6ad167"


def error_fixture():
    app = FastAPI()
    install_api_error_handlers(app)

    @app.middleware("http")
    async def trusted_request_context(request, call_next):
        request.scope.setdefault("state", {})["request_id"] = REQUEST_ID
        return await call_next(request)

    class Payload(BaseModel):
        count: int = Field(gt=0)

    @app.get("/conflict")
    async def conflict():
        raise HTTPException(409, detail={
            "code": "duplicate_assignment",
            "message": "The operator already has an assignment",
            "details": {"operator": "operator-1"},
        })

    @app.post("/validate")
    async def validate(payload: Payload):
        return payload

    @app.get("/unexpected")
    async def unexpected():
        raise RuntimeError("private implementation detail")

    @app.get("/upstream/{status_code}")
    async def upstream_failure(status_code: int):
        raise HTTPException(status_code, "Dependency unavailable", headers={"Retry-After": "7"})

    return app


class ApiErrorContractTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=error_fixture(), raise_app_exceptions=False),
            base_url="http://test",
        )
        self.addAsyncCleanup(self.client.aclose)

    async def test_http_errors_keep_detail_and_add_machine_readable_error(self):
        response = await self.client.get("/conflict")
        self.assertEqual(response.status_code, 409)
        body = response.json()
        self.assertEqual(body["detail"]["code"], "duplicate_assignment")
        self.assertEqual(body["error"], {
            "code": "duplicate_assignment",
            "message": "The operator already has an assignment",
            "details": {"operator": "operator-1"},
        })

    async def test_validation_errors_have_safe_machine_details_and_legacy_detail(self):
        response = await self.client.post("/validate", json={"count": 0})
        self.assertEqual(response.status_code, 422)
        body = response.json()
        self.assertIsInstance(body["detail"], list)
        self.assertEqual(body["error"]["code"], "request_validation_error")
        self.assertEqual(body["error"]["details"][0]["location"], ["body", "count"])
        self.assertNotIn("input", body["error"]["details"][0])

    async def test_unexpected_errors_do_not_disclose_exception_text(self):
        with self.assertLogs("api_errors", level="ERROR") as captured:
            response = await self.client.get("/unexpected?secret=private-query", headers={"X-Request-ID": "untrusted-header"})
        self.assertEqual(response.status_code, 500)
        body = response.json()
        self.assertEqual(body["error"]["code"], "internal_error")
        self.assertNotIn("private implementation detail", response.text)
        self.assertEqual(response.headers["X-Request-ID"], REQUEST_ID)
        self.assertEqual(captured.records[0].request_id, REQUEST_ID)
        self.assertEqual(captured.records[0].exception_type, "RuntimeError")
        self.assertNotIn("private", " ".join(captured.output))
        self.assertIsNone(captured.records[0].exc_info)

    async def test_known_upstream_failures_keep_distinct_codes_and_retry_headers(self):
        for status, code in ((502, "bad_gateway"), (503, "service_unavailable"), (504, "upstream_timeout")):
            with self.subTest(status=status):
                response = await self.client.get(f"/upstream/{status}")
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.json()["error"]["code"], code)
                self.assertEqual(response.json()["detail"], "Dependency unavailable")
                self.assertEqual(response.headers["Retry-After"], "7")

    async def test_early_request_admission_rejections_use_the_same_error_shape(self):
        app = FastAPI()
        app.add_middleware(RequestAdmissionMiddleware)
        install_api_error_handlers(app)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            with patch.object(settings, "REQUEST_ADMISSION_CONCURRENCY", 0):
                response = await client.get("/anything")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"], "Request capacity exhausted")
        self.assertEqual(response.json()["error"]["code"], "service_unavailable")


if __name__ == "__main__":
    unittest.main()
