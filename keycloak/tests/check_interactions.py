"""Real, disposable-provider checks for the custom app authentication protocol."""
import base64
import concurrent.futures
import hashlib
import json
import secrets
import time
import unittest
from urllib.parse import quote

import httpx
import check_keycloak as browser_helpers

BASE = "http://admin.auth.fixture:1015/realms/inout/inout-auth"
CLIENT = httpx.BasicAuth("inout-frontend", "isolated-keycloak-test-client-secret")


class InteractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = browser_helpers.KeycloakCompatibilityTests
        cls.fixture.setUpClass()
        cls.client = httpx.Client(timeout=25, follow_redirects=False, trust_env=False)
        cls.frontend = cls.fixture.admin_request("GET", "/clients?clientId=inout-frontend").json()[0]
        assert cls.frontend["directAccessGrantsEnabled"] is False
        assert cls.frontend["attributes"]["inout.app-interactions.enabled"] == "true"

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        cls.fixture.tearDownClass()

    def setUp(self):
        self.user = self.fixture.users["zone-admin"]
        self.verifier = secrets.token_urlsafe(32)
        self.challenge = base64.urlsafe_b64encode(hashlib.sha256(self.verifier.encode()).digest()).rstrip(b"=").decode()

    def post(self, action, payload, **options):
        return self.client.post(BASE + "/" + action, auth=CLIENT, json=payload, **options)

    def proof(self, **changes):
        return self.post("verify", {"mode": "login", "username": self.user["username"],
            "currentPassword": self.user["password"], "codeChallenge": self.challenge, **changes})

    def redeem(self, code, verifier=None):
        return self.post("token", {"code": code, "codeVerifier": verifier or self.verifier})

    def test_client_authentication_origin_gate_and_public_boundary(self):
        response = self.client.get(BASE + "/status", auth=CLIENT)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"extensionVersion": 1, "keycloakVersion": "26.8.2", "protocol": "inout-app-interactions-v1"})
        self.assertIn("no-store", response.headers["cache-control"])
        for options in ({}, {"auth": httpx.BasicAuth("inout-frontend", "incorrect-fixture-secret")},
                        {"auth": CLIENT, "headers": {"Origin": "http://foreign.invalid"}}):
            self.assertEqual(self.client.get(BASE + "/status", **options).status_code, 401)
        for path in ("status", "prepare", "verify", "token", "%76erify"):
            denied = self.client.get("http://auth.fixture:1014/realms/inout/inout-auth/" + path)
            self.assertEqual(denied.status_code, 404)
        path = "/clients/" + self.frontend["id"]
        try:
            self.fixture.admin_request("PUT", path, json={"attributes": {**self.frontend["attributes"], "inout.app-interactions.enabled": "false"}}).raise_for_status()
            self.assertEqual(self.client.get(BASE + "/status", auth=CLIENT).status_code, 200)
            self.assertEqual(self.proof().status_code, 403)
        finally:
            self.fixture.admin_request("PUT", path, json={"attributes": self.frontend["attributes"]}).raise_for_status()

    def test_pkce_code_issues_verified_tokens_once_and_can_refresh(self):
        proof = self.proof()
        self.assertEqual(proof.status_code, 200, proof.text)
        ticket = proof.json()
        self.assertEqual(ticket["subject"], self.user["id"])
        self.assertEqual(ticket["expiresIn"], 30)
        self.assertNotIn("access_token", ticket)
        result = self.redeem(ticket["code"])
        self.assertEqual(result.status_code, 200, result.text)
        tokens = result.json()
        verifier = self.fixture("test_password_grant_requires_the_confidential_app_and_rejects_invalid_credentials")
        access = verifier.verify_token(tokens["access_token"], "inout-frontend")
        identity = verifier.verify_token(tokens["id_token"], "inout-frontend")
        verifier.assert_application_token_pair(tokens, identity, access)
        self.assertEqual(access["sub"], self.user["id"])
        self.assertGreaterEqual(identity["auth_time"], time.time() - 60)
        self.assertEqual(self.redeem(ticket["code"]).status_code, 401)
        refreshed = self.client.post(browser_helpers.ISSUER + "/protocol/openid-connect/token", data={
            "grant_type": "refresh_token", "client_id": "inout-frontend", "client_secret": browser_helpers.CLIENT_SECRET,
            "refresh_token": tokens["refresh_token"]})
        self.assertEqual(refreshed.status_code, 200, refreshed.text)
        refresh_token = refreshed.json().get("refresh_token", tokens["refresh_token"])
        revoked = self.client.post(browser_helpers.ISSUER + "/protocol/openid-connect/revoke", data={
            "client_id": "inout-frontend", "client_secret": browser_helpers.CLIENT_SECRET,
            "token": refresh_token, "token_type_hint": "refresh_token"})
        self.assertEqual(revoked.status_code, 200)
        rejected = self.client.post(browser_helpers.ISSUER + "/protocol/openid-connect/token", data={
            "grant_type": "refresh_token", "client_id": "inout-frontend", "client_secret": browser_helpers.CLIENT_SECRET,
            "refresh_token": refresh_token})
        self.assertEqual(rejected.status_code, 400)
        self.assertEqual(rejected.json().get("error"), "invalid_grant")

    def test_wrong_verifier_burns_code_and_parallel_redeem_has_one_winner(self):
        first = self.proof().json()
        self.assertEqual(self.redeem(first["code"], secrets.token_urlsafe(32)).status_code, 401)
        self.assertEqual(self.redeem(first["code"]).status_code, 401)
        second = self.proof().json()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.redeem(second["code"]).status_code, range(2)))
        self.assertEqual(sorted(results), [200, 401])

    def test_wrong_password_and_unknown_account_have_no_tokens(self):
        wrong = self.proof(currentPassword="incorrect-fixture-password")
        unknown = self.proof(username="nonexistent-fixture-account", currentPassword="incorrect-fixture-password")
        self.assertEqual(wrong.status_code, 401)
        self.assertEqual(wrong.json(), unknown.json())
        self.assertEqual(wrong.json(), {"error": "credentials"})
        malformed = self.client.post(BASE + "/verify", auth=CLIENT, headers={"Content-Type": "application/json"},
            content='{"mode":"login","mode":"setup"}')
        self.assertEqual(malformed.status_code, 400)
        self.assertEqual(self.post("prepare", {"username": "x" * 255}).status_code, 400)

    def test_native_brute_force_lock_blocks_correct_credentials_until_cleared(self):
        # Native failure accounting is asynchronous. Wait for each recorded
        # failure rather than depending on scheduling or sending a login storm.
        realm = self.fixture.admin_request("GET", "").json()
        settings = {"bruteForceProtected": True, "permanentLockout": False,
            "failureFactor": 3, "waitIncrementSeconds": 60,
            "minimumQuickLoginWaitSeconds": 60, "maxFailureWaitSeconds": 60,
            "quickLoginCheckMilliSeconds": 0, "maxDeltaTimeSeconds": 900}
        previous = {key: realm[key] for key in settings}
        path = "/attack-detection/brute-force/users/" + self.user["id"]
        try:
            self.fixture.admin_request("DELETE", path).raise_for_status()
            self.fixture.admin_request("PUT", "", json=settings).raise_for_status()
            for attempt in range(1, 4):
                rejected = self.proof(currentPassword="incorrect-brute-force-fixture-password")
                self.assertEqual(rejected.status_code, 401)
                deadline = time.monotonic() + 5
                recorded = {}
                while time.monotonic() < deadline:
                    result = self.fixture.admin_request("GET", path)
                    result.raise_for_status()
                    recorded = result.json()
                    if recorded.get("numFailures", 0) >= attempt:
                        break
                    time.sleep(0.05)
                self.assertGreaterEqual(recorded.get("numFailures", 0), attempt,
                    "Custom authentication must retain native failure accounting")
            self.assertTrue(recorded.get("disabled"), "The native temporary lock must be active")
            blocked = self.proof()
            self.assertEqual(blocked.status_code, 401)
            self.assertEqual(blocked.json(), {"error": "credentials"})
        finally:
            # Restore policy and this user's lock even when an assertion fails;
            # later OTP and credential tests use the same disposable realm.
            try:
                self.fixture.admin_request("DELETE", path).raise_for_status()
            finally:
                self.fixture.admin_request("PUT", "", json=previous).raise_for_status()
        allowed = self.proof()
        self.assertEqual(allowed.status_code, 200, allowed.text)

    def test_unsafe_configured_flow_cannot_skip_password_verification(self):
        # Never edit a built-in flow. Bind a disposable copy to this fixture's
        # app client, remove its password execution, and restore everything.
        realm = self.fixture.admin_request("GET", "").json()
        alias = "interaction-unsafe-fixture-" + secrets.token_hex(6)
        source = quote(realm["directGrantFlow"], safe="")
        flow_path = "/authentication/flows/" + quote(alias, safe="")
        client_path = "/clients/" + self.frontend["id"]
        current_client = self.fixture.admin_request("GET", client_path).json()
        old_bindings = current_client.get("authenticationFlowBindingOverrides") or {}
        # Keycloak applies this map entry-by-entry: an empty map does not
        # remove a newly added override. Explicit null restores inheritance.
        restore_bindings = {**old_bindings, "direct_grant": old_bindings.get("direct_grant")}
        flow_id = None
        password_execution = None
        try:
            copied = self.fixture.admin_request("POST", "/authentication/flows/" + source + "/copy",
                json={"newName": alias})
            self.assertEqual(copied.status_code, 201, copied.text)
            flow_id = copied.headers["location"].rsplit("/", 1)[1]
            executions = self.fixture.admin_request("GET", flow_path + "/executions").json()
            password_execution = next(execution for execution in executions
                if execution.get("providerId") == "direct-grant-validate-password")
            self.fixture.admin_request("PUT", flow_path + "/executions",
                json={**password_execution, "requirement": "DISABLED"}).raise_for_status()
            self.fixture.admin_request("PUT", client_path, json={"authenticationFlowBindingOverrides": {
                **old_bindings, "direct_grant": flow_id}}).raise_for_status()
            for password in (self.user["password"], "incorrect-skipped-fixture-password"):
                rejected = self.proof(currentPassword=password)
                self.assertEqual(rejected.status_code, 503, rejected.text)
                self.assertEqual(rejected.json(), {"error": "service_unavailable"})
        finally:
            try:
                self.fixture.admin_request("PUT", client_path,
                    json={"authenticationFlowBindingOverrides": restore_bindings}).raise_for_status()
            finally:
                try:
                    if password_execution:
                        self.fixture.admin_request("PUT", flow_path + "/executions",
                            json=password_execution).raise_for_status()
                finally:
                    if flow_id:
                        self.fixture.admin_request("DELETE", "/authentication/flows/" + flow_id).raise_for_status()
        accepted = self.proof()
        self.assertEqual(accepted.status_code, 200, accepted.text)
        restored = self.fixture.admin_request("GET", client_path).json()
        self.assertEqual(restored.get("authenticationFlowBindingOverrides") or {}, old_bindings)

    def test_username_email_aliases_pin_the_same_subject_and_reject_retargeting(self):
        user_path = "/users/" + self.user["id"]
        user = self.fixture.admin_request("GET", user_path).json()
        credentials = self.fixture.admin_request("GET", user_path + "/credentials").json()
        other_subject = self.fixture.users["operator"]["id"]
        for name in (self.user["username"], user["email"]):
            prepared = self.post("prepare", {"username": name})
            self.assertEqual(prepared.status_code, 200, prepared.text)
            self.assertEqual(prepared.json(), {"subject": self.user["id"]})
            mismatch = self.post("prepare", {"username": name, "expectedSubject": other_subject})
            self.assertEqual(mismatch.status_code, 401)
            self.assertEqual(mismatch.json(), {"error": "credentials"})
            denied_login = self.proof(username=name, expectedSubject=other_subject)
            self.assertEqual(denied_login.status_code, 401)
            self.assertNotIn("code", denied_login.json())
            denied_change = self.post("verify", {"mode": "change", "username": name,
                "currentPassword": self.user["password"], "newPassword": secrets.token_urlsafe(32),
                "expectedSubject": other_subject})
            self.assertEqual(denied_change.status_code, 401)
        try:
            self.fixture.admin_request("PUT", user_path, json={"requiredActions": ["UPDATE_PASSWORD"]}).raise_for_status()
            denied_setup = self.post("verify", {"mode": "setup", "username": user["email"],
                "currentPassword": self.user["password"], "newPassword": secrets.token_urlsafe(32),
                "expectedSubject": other_subject})
            self.assertEqual(denied_setup.status_code, 401)
            self.assertIn("UPDATE_PASSWORD", self.fixture.admin_request("GET", user_path).json()["requiredActions"])
        finally:
            self.fixture.admin_request("PUT", user_path,
                json={"requiredActions": user.get("requiredActions", [])}).raise_for_status()
        self.assertEqual(self.fixture.admin_request("GET", user_path + "/credentials").json(), credentials)

    def test_account_change_after_proof_cannot_redeem(self):
        ticket = self.proof().json()
        path = "/users/" + self.user["id"]
        try:
            self.fixture.admin_request("PUT", path, json={"enabled": False}).raise_for_status()
            self.assertEqual(self.redeem(ticket["code"]).status_code, 401)
        finally:
            self.fixture.admin_request("PUT", path, json={"enabled": True}).raise_for_status()
        ticket = self.proof().json()
        try:
            self.fixture.admin_request("PUT", path, json={"requiredActions": ["CONFIGURE_TOTP"]}).raise_for_status()
            self.assertIn(self.redeem(ticket["code"]).status_code, (401, 409))
        finally:
            self.fixture.admin_request("PUT", path, json={"requiredActions": []}).raise_for_status()

    def test_setup_policy_failure_is_atomic_and_unsupported_actions_remain(self):
        path = "/users/" + self.user["id"]
        new_password = secrets.token_urlsafe(32)
        original_policy = self.fixture.admin_request("GET", "").json().get("passwordPolicy", "")
        try:
            self.fixture.admin_request("PUT", path, json={"requiredActions": ["UPDATE_PASSWORD"]}).raise_for_status()
            self.assertEqual(self.proof().json(), {"error": "account_setup_required"})
            self.fixture.admin_request("PUT", "", json={"passwordPolicy": "length(20)"}).raise_for_status()
            rejected = self.post("verify", {"mode": "setup", "username": self.user["username"],
                "currentPassword": self.user["password"], "newPassword": "short", "expectedSubject": self.user["id"]})
            self.assertEqual(rejected.status_code, 422, rejected.text)
            failed_events = self.fixture.admin_request("GET", "/events", params={
                "type": "UPDATE_CREDENTIAL_ERROR", "user": self.user["id"], "max": 20,
            }).json()
            self.assertTrue(any(event.get("error") == "password_rejected" and
                event.get("details", {}).get("credential_type") == "password" for event in failed_events), failed_events)
            self.assertIn("UPDATE_PASSWORD", self.fixture.admin_request("GET", path).json()["requiredActions"])
            completed = self.post("verify", {"mode": "setup", "username": self.user["username"],
                "currentPassword": self.user["password"], "newPassword": new_password, "expectedSubject": self.user["id"]})
            self.assertEqual(completed.status_code, 200, completed.text)
            success_events = self.fixture.admin_request("GET", "/events", params={
                "type": "UPDATE_CREDENTIAL", "user": self.user["id"], "max": 20,
            }).json()
            self.assertTrue(any(event.get("details", {}).get("credential_type") == "password" for event in success_events), success_events)
            self.assertNotIn(new_password, json.dumps([failed_events, success_events]))
            self.user["password"] = new_password
            self.fixture.admin_request("PUT", path, json={"requiredActions": ["UPDATE_PASSWORD", "CONFIGURE_TOTP"]}).raise_for_status()
            blocked = self.post("verify", {"mode": "setup", "username": self.user["username"],
                "currentPassword": new_password, "newPassword": secrets.token_urlsafe(32), "expectedSubject": self.user["id"]})
            self.assertEqual(blocked.status_code, 401)
            self.assertEqual(sorted(self.fixture.admin_request("GET", path).json()["requiredActions"]), ["CONFIGURE_TOTP", "UPDATE_PASSWORD"])
        finally:
            self.fixture.admin_request("PUT", "", json={"passwordPolicy": original_policy}).raise_for_status()
            self.fixture.admin_request("PUT", path, json={"requiredActions": []}).raise_for_status()

    def test_unsupported_totp_enrollment_fails_closed(self):
        user_path = "/users/" + self.user["id"]
        self.fixture.admin_request("PUT", user_path, json={"requiredActions": ["CONFIGURE_TOTP"]}).raise_for_status()
        try:
            blocked = self.proof()
            self.assertEqual(blocked.status_code, 409)
            self.assertEqual(blocked.json(), {"error": "not_ready"})
            self.assertNotIn("code", blocked.json())
        finally:
            self.fixture.admin_request("PUT", user_path, json={"requiredActions": []}).raise_for_status()
    def test_zz_expired_code_cannot_issue_session(self):
        code = self.proof().json()["code"]
        time.sleep(31)
        self.assertEqual(self.redeem(code).status_code, 401)


if __name__ == "__main__":
    unittest.main(verbosity=2)
