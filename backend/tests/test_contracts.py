import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import HTTPException
from schemas import BrowserScanPayload
from movement_logic import evaluate_scan, apply_movement_state
from auth import verify_admin_request, verify_terminal_operator_request
from fastapi.security import HTTPAuthorizationCredentials
from auth import verify_keycloak_token
from jose import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization
from datetime import datetime, timezone, timedelta


class ContractTests(unittest.TestCase):
    def test_signed_tokens_require_the_configured_audience(self):
        private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        key = private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        public = private.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        claims = {"sub": "admin", "iss": "https://identity.test/realms/inout", "aud": "another-client", "exp": datetime.now(timezone.utc) + timedelta(minutes=5)}
        with patch("auth._load_jwks", return_value=public), patch("auth.settings.KEYCLOAK_ISSUER", claims["iss"]):
            with self.assertRaises(HTTPException) as error:
                verify_keycloak_token(jwt.encode(claims, key, algorithm="RS256"))
            self.assertEqual(error.exception.status_code, 401)
            claims["aud"] = "inout-frontend"
            self.assertEqual(verify_keycloak_token(jwt.encode(claims, key, algorithm="RS256"))["sub"], "admin")

    def test_browser_scan_payload(self):
        payload = BrowserScanPayload.model_validate({"barcode": "a1", "checkpointId": "cp1",
            "selectedHardwareIds": ["h1"], "online": True, "scanType": "auto"})
        self.assertEqual(payload.checkpoint_id, "cp1")
        self.assertEqual(payload.selected_hardware_ids, ["h1"])
        self.assertIsNone(payload.direction)

    def test_missing_bearer_is_401_even_in_dev(self):
        with patch("auth.settings.ENV", "dev"):
            with self.assertRaises(HTTPException) as error:
                asyncio.run(verify_admin_request(None))
        self.assertEqual(error.exception.status_code, 401)

    def test_terminal_role_is_exclusive_from_admin(self):
        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials="test-token")
        with patch("auth.verify_keycloak_token", return_value={"sub": "operator", "realm_access": {"roles": ["operator"]}}):
            self.assertEqual(asyncio.run(verify_terminal_operator_request(credentials))["sub"], "operator")
        for roles in (["admin"], ["admin", "operator"], []):
            with patch("auth.verify_keycloak_token", return_value={"realm_access": {"roles": roles}}):
                with self.assertRaises(HTTPException) as error:
                    asyncio.run(verify_terminal_operator_request(credentials))
                self.assertEqual(error.exception.status_code, 403)

    def test_hardware_is_recognized_and_updates_presence(self):
        asset = {"id": "h1", "name": "Laptop", "barcode": "h1", "category": "Laptop",
            "status": "active", "inside": False, "allowedZones": ["All Zones"]}
        decision = evaluate_scan(barcode="h1", checkpoint={"id": "cp1", "mode": "entry"},
            people=[], hardware=[asset], selected_hardware_ids=[], online=True, event_count=0, scan_type="auto")
        self.assertEqual(decision["event"]["result"], "approved")
        self.assertTrue(apply_movement_state(decision["event"], [], [asset])["hardware"][0]["inside"])

    def test_carried_hardware_custody_is_enforced(self):
        person = {"id": "p1", "name": "Alice", "barcode": "p1", "type": "employee",
            "status": "active", "inside": False, "allowedZones": ["All Zones"]}
        asset = {"id": "h1", "name": "Laptop", "category": "Laptop", "status": "active", "assignedEmployeeId": "p2"}
        decision = evaluate_scan(barcode="p1", checkpoint={"mode": "entry"}, people=[person],
            hardware=[asset], selected_hardware_ids=["h1"], online=True, event_count=0, scan_type="auto")
        self.assertEqual(decision["event"]["denialCode"], "custody_mismatch")


if __name__ == "__main__":
    unittest.main()
