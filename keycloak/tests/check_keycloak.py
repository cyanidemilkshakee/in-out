"""Real image/import/OIDC compatibility checks against an isolated provider."""
import base64
import hashlib
import html
import hmac
import re
import secrets
import time
import unittest
from urllib.parse import parse_qs, urljoin, urlparse

import httpx
import jwt

PUBLIC = "http://auth.fixture:8005"
ADMIN = "http://admin.auth.fixture:8006"
ISSUER = PUBLIC + "/realms/inout"
CLIENT_SECRET = "isolated-keycloak-test-client-secret"
CALLBACK = "http://app.fixture:3000/api/auth/callback/keycloak"


def strong_password():
    return "Aa9!" + secrets.token_urlsafe(28)


class KeycloakCompatibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = httpx.Client(timeout=20, follow_redirects=False, trust_env=False)
        login = cls.client.post(ADMIN + "/realms/master/protocol/openid-connect/token", data={
            "grant_type": "password", "client_id": "admin-cli", "username": "fixture-master",
            "password": "isolated-keycloak-test-master-password",
        })
        if login.status_code != 200:
            raise AssertionError(f"Fixture master login failed (HTTP {login.status_code})")
        cls.master_token = login.json()["access_token"]
        cls.master_refresh = login.json()["refresh_token"]
        cls.master_expires_at = time.time() + login.json()["expires_in"]
        cls.jwks = cls.client.get(ISSUER + "/protocol/openid-connect/certs").json()
        cls.admin_request("POST", "/roles", json={"name": "fixture-unrelated-role"}).raise_for_status()
        unrelated_role = cls.admin_request("GET", "/roles/fixture-unrelated-role").json()
        cls.users = {}
        for role in ("operator", "admin"):
            username = "fixture-" + role
            password = strong_password()
            created = cls.admin_request("POST", "/users", json={
                "username": username, "enabled": True, "email": username + "@example.invalid",
                "firstName": "Compatibility", "lastName": "Fixture", "emailVerified": True,
                "requiredActions": [], "credentials": [{"type": "password", "value": password, "temporary": False}],
            })
            if created.status_code != 201:
                raise AssertionError(f"Fixture creation failed (HTTP {created.status_code})")
            user_id = created.headers["location"].rsplit("/", 1)[1]
            cls.users[role] = {"id": user_id, "username": username, "password": password}
            defaults = cls.admin_request("GET", f"/users/{user_id}/role-mappings/realm").json()
            if defaults:
                cls.admin_request("DELETE", f"/users/{user_id}/role-mappings/realm", json=defaults).raise_for_status()
            mapping = cls.admin_request("GET", "/roles/" + role).json()
            cls.admin_request("POST", f"/users/{user_id}/role-mappings/realm", json=[mapping, unrelated_role]).raise_for_status()
        # Ensure the public boundary holds even if SCIM is enabled explicitly.
        cls.admin_request("PUT", "", json={"scimApiEnabled": True}).raise_for_status()

    @classmethod
    def tearDownClass(cls):
        for user in cls.users.values():
            cls.admin_request("DELETE", "/users/" + user["id"]).raise_for_status()
        cls.admin_request("DELETE", "/roles/fixture-unrelated-role").raise_for_status()
        cls.client.close()

    @classmethod
    def admin_request(cls, method, path, **kwargs):
        # The master admin-cli token lasts one minute. A full real-provider
        # suite can exceed that without changing the realm's security policy.
        if time.time() >= cls.master_expires_at - 10:
            renewed = cls.client.post(ADMIN + "/realms/master/protocol/openid-connect/token", data={
                "grant_type": "refresh_token", "client_id": "admin-cli", "refresh_token": cls.master_refresh,
            })
            renewed.raise_for_status()
            cls.master_token = renewed.json()["access_token"]
            cls.master_refresh = renewed.json()["refresh_token"]
            cls.master_expires_at = time.time() + renewed.json()["expires_in"]
        return cls.client.request(method, ADMIN + "/admin/realms/inout" + path,
            headers={"Authorization": "Bearer " + cls.master_token}, **kwargs)

    def verify_token(self, token, audience):
        kid = jwt.get_unverified_header(token)["kid"]
        key = next(key for key in self.jwks["keys"] if key["kid"] == kid)
        return jwt.decode(token, jwt.PyJWK.from_dict(key, algorithm="RS256").key,
            algorithms=["RS256"], audience=audience, issuer=ISSUER)

    def assert_application_token_pair(self, tokens, identity, access):
        # Confirm the real provider's token kinds and any optional OIDC binding
        # claims before the application's token validator relies on them.
        self.assertEqual(identity.get("typ"), "ID")
        self.assertEqual(access.get("typ"), "Bearer")
        self.assertEqual(identity["sub"], access["sub"])
        self.assertEqual(identity.get("azp"), "inout-frontend")
        self.assertEqual(access.get("azp"), "inout-frontend")
        for claim in ("sid", "session_state"):
            if claim in identity and claim in access:
                self.assertIsInstance(identity[claim], str)
                self.assertTrue(identity[claim])
                self.assertEqual(identity[claim], access[claim])
        if "at_hash" in identity:
            digest = hashlib.sha256(tokens["access_token"].encode("ascii")).digest()
            expected = base64.urlsafe_b64encode(digest[:len(digest) // 2]).rstrip(b"=").decode()
            self.assertEqual(identity["at_hash"], expected)

    @staticmethod
    def otp_code(secret):
        counter = int(time.time()) // 30
        digest = hmac.new(secret, counter.to_bytes(8, "big"), hashlib.sha1).digest()
        offset = digest[-1] & 15
        return str((int.from_bytes(digest[offset:offset + 4], "big") & 0x7fffffff) % 1_000_000).zfill(6)

    def follow_provider_action(self, browser, response):
        for _ in range(3):
            if response.status_code not in (302, 303):
                return response
            location = urljoin(PUBLIC, response.headers["location"])
            self.assertEqual(urlparse(location).netloc, urlparse(PUBLIC).netloc)
            response = browser.get(location)
        return response

    def sign_in(self, role, client_id="inout-frontend", password_update=None, configure_otp=False):
        user = self.users[role]
        verifier = secrets.token_urlsafe(32)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        state = secrets.token_urlsafe(16)
        nonce = secrets.token_urlsafe(16)
        redirect = {
            "inout-frontend": CALLBACK,
            "inout-postman": "https://oauth.pstmn.io/v1/callback",
            "account-console": ISSUER + "/account/",
        }[client_id]
        with httpx.Client(timeout=20, follow_redirects=False, trust_env=False) as browser:
            page = browser.get(ISSUER + "/protocol/openid-connect/auth", params={
                "client_id": client_id, "redirect_uri": redirect, "response_type": "code", "scope": "openid profile email",
                "state": state, "nonce": nonce, "code_challenge": challenge, "code_challenge_method": "S256",
                "prompt": "login", "max_age": "0",
            })
            self.assertEqual(page.status_code, 200, "OIDC login must present the password form")
            self.assertEqual(page.headers.get("X-RateLimit-Limit-Minute"), "600")
            self.assertNotIn("/css/inout.css", page.text, "Account setup must use the built-in provider pages")
            form = re.search(r'<form\b[^>]*id="kc-form-login"[^>]*>', page.text)
            self.assertIsNotNone(form, "Built-in login form is missing")
            action = html.unescape(re.search(r'action="([^"]+)"', form[0])[1])
            self.assertEqual(urlparse(action).netloc, urlparse(PUBLIC).netloc, "Credentials must stay on the fixture provider")
            completed = browser.post(action, data={"username": user["username"], "password": user["password"], "credentialId": ""})
            if configure_otp:
                completed = self.follow_provider_action(browser, completed)
                self.assertEqual(completed.status_code, 200)
                manual = re.search(r'<a\b[^>]*id="mode-manual"[^>]*>', completed.text)
                self.assertIsNotNone(manual, "Stock OTP setup must retain the manual alternative to its QR code")
                manual_url = urljoin(PUBLIC, html.unescape(re.search(r'href="([^"]+)"', manual[0])[1]))
                self.assertEqual(urlparse(manual_url).netloc, urlparse(PUBLIC).netloc)
                completed = browser.get(manual_url)
                encoded = re.search(r'id="kc-totp-secret-key"[^>]*>([^<]+)<', completed.text)
                self.assertIsNotNone(encoded)
                encoded = re.sub(r"\s", "", html.unescape(encoded[1]))
                secret = base64.b32decode(encoded + "=" * (-len(encoded) % 8))
                form = re.search(r'<form\b[^>]*id="kc-totp-settings-form"[^>]*>', completed.text)
                self.assertIsNotNone(form, "Stock OTP enrollment form must remain available")
                action = html.unescape(re.search(r'action="([^"]+)"', form[0])[1])
                hidden_secret = re.search(r'<input\b[^>]*name="totpSecret"[^>]*value="([^"]+)"', completed.text)
                self.assertIsNotNone(hidden_secret)
                self.assertEqual(urlparse(action).netloc, urlparse(PUBLIC).netloc)
                user["last_otp_counter"] = int(time.time()) // 30
                completed = browser.post(action, data={"totp": self.otp_code(secret),
                    "totpSecret": html.unescape(hidden_secret[1]), "userLabel": "Isolated fixture authenticator", "mode": "manual"})
                self.assertEqual(completed.status_code, 302, "OTP enrollment must complete before issuing a code")
                user["otp_secret"] = secret
            elif user.get("otp_secret"):
                completed = self.follow_provider_action(browser, completed)
                self.assertEqual(completed.status_code, 200)
                form = re.search(r'<form\b[^>]*id="kc-otp-login-form"[^>]*>', completed.text)
                self.assertIsNotNone(form, "Enrolled users must see the stock OTP challenge")
                action = html.unescape(re.search(r'action="([^"]+)"', form[0])[1])
                self.assertEqual(urlparse(action).netloc, urlparse(PUBLIC).netloc)
                # Keycloak rejects replay of the enrollment code. Use a new
                # TOTP window, preserving its default replay protection.
                while int(time.time()) // 30 <= user.get("last_otp_counter", -1):
                    time.sleep(0.25)
                valid_code = self.otp_code(user["otp_secret"])
                rejected = browser.post(action, data={"otp": str((int(valid_code) + 1) % 1_000_000).zfill(6)})
                self.assertEqual(rejected.status_code, 200, "An incorrect OTP must retain the challenge")
                form = re.search(r'<form\b[^>]*id="kc-otp-login-form"[^>]*>', rejected.text)
                self.assertIsNotNone(form)
                action = html.unescape(re.search(r'action="([^"]+)"', form[0])[1])
                self.assertEqual(urlparse(action).netloc, urlparse(PUBLIC).netloc)
                completed = browser.post(action, data={"otp": self.otp_code(user["otp_secret"])})
            if password_update is not None:
                # Exercise the provider's browser UPDATE_PASSWORD action, which
                # can bypass application endpoints and their validation.
                for _ in range(3):
                    if completed.status_code not in (302, 303):
                        break
                    location = completed.headers["location"]
                    self.assertEqual(urlparse(location).netloc, urlparse(PUBLIC).netloc)
                    completed = browser.get(location)
                form = re.search(r'<form\b[^>]*id="kc-passwd-update-form"[^>]*>', completed.text)
                self.assertEqual(completed.status_code, 200)
                self.assertIsNotNone(form)
                action = html.unescape(re.search(r'action="([^"]+)"', form[0])[1])
                self.assertEqual(urlparse(action).netloc, urlparse(PUBLIC).netloc)
                rejected = browser.post(action, data={"password-new": "x", "password-confirm": "x"})
                self.assertEqual(rejected.status_code, 200, "Short password must remain on the provider form")
                form = re.search(r'<form\b[^>]*id="kc-passwd-update-form"[^>]*>', rejected.text)
                self.assertIsNotNone(form, "Rejected password must not complete the required action")
                action = html.unescape(re.search(r'action="([^"]+)"', form[0])[1])
                self.assertEqual(urlparse(action).netloc, urlparse(PUBLIC).netloc)
                completed = browser.post(action, data={
                    "password-new": password_update, "password-confirm": password_update,
                })
                self.assertEqual(completed.status_code, 302, "Strong password must complete the required action")
                user["password"] = password_update
            self.assertEqual(completed.status_code, 302, "Fresh fixture login must complete")
            callback = urlparse(completed.headers["location"])
            self.assertEqual(callback._replace(query="", fragment="").geturl(), redirect)
            query = parse_qs(callback.query)
            self.assertEqual(query["state"], [state])
            exchanged = browser.post(ISSUER + "/protocol/openid-connect/token", data={
                "grant_type": "authorization_code", "client_id": client_id, "code": query["code"][0],
                "redirect_uri": redirect, "code_verifier": verifier,
                **({"client_secret": CLIENT_SECRET} if client_id == "inout-frontend" else {}),
            })
            self.assertEqual(exchanged.status_code, 200, "S256 authorization-code exchange must succeed")
            tokens = exchanged.json()
            id_claims = self.verify_token(tokens["id_token"], client_id)
            self.assertEqual(id_claims["nonce"], nonce)
            self.assertGreaterEqual(id_claims["auth_time"], time.time() - 60)
            if client_id == "inout-frontend":
                access = self.verify_token(tokens["access_token"], "inout-frontend")
                self.assert_application_token_pair(tokens, id_claims, access)
            return tokens, id_claims

    def direct_sign_in(self, role, otp=None):
        user = self.users[role]
        result = self.client.post(ISSUER + "/protocol/openid-connect/token", data={
            "grant_type": "password", "client_id": "inout-frontend", "client_secret": CLIENT_SECRET,
            "username": user["username"], "password": user["password"], "scope": "openid profile email",
            **({"totp": otp} if otp is not None else {}),
        })
        if result.status_code != 200:
            error = result.json()
            self.fail("The confidential app form rejected a fully configured account: "
                f"HTTP {result.status_code}, {error.get('error')}, {error.get('error_description')}")
        tokens = result.json()
        claims = self.verify_token(tokens["id_token"], "inout-frontend")
        access = self.verify_token(tokens["access_token"], "inout-frontend")
        self.assertEqual(claims["sub"], user["id"])
        self.assertEqual(access["sub"], user["id"])
        self.assert_application_token_pair(tokens, claims, access)
        # Direct grants may omit auth_time. Its signed iat can anchor this fresh
        # password exchange; never replace provider timestamps with a local clock.
        authenticated = claims.get("auth_time", access.get("auth_time", claims["iat"]))
        self.assertIsInstance(authenticated, int)
        self.assertGreaterEqual(authenticated, time.time() - 30)
        self.assertLessEqual(authenticated, time.time() + 1)
        if "auth_time" in access:
            self.assertEqual(access["auth_time"], authenticated)
        return tokens, claims

    def test_import_discovery_and_separate_admin_console(self):
        discovery = self.client.get(ISSUER + "/.well-known/openid-configuration")
        self.assertEqual(discovery.status_code, 200)
        self.assertEqual(discovery.headers.get("X-RateLimit-Limit-Minute"), "600")
        self.assertEqual(discovery.json()["issuer"], ISSUER)
        self.assertEqual(discovery.json()["authorization_endpoint"], ISSUER + "/protocol/openid-connect/auth")
        clients = self.admin_request("GET", "/clients?clientId=inout-frontend")
        self.assertEqual(clients.status_code, 200)
        client = clients.json()[0]
        self.assertEqual(client["redirectUris"], [CALLBACK])
        self.assertEqual(client["webOrigins"], ["http://app.fixture:3000"])
        self.assertIs(client["standardFlowEnabled"], True)
        self.assertIs(client["directAccessGrantsEnabled"], True)
        self.assertIs(client["implicitFlowEnabled"], False)
        self.assertEqual(client["attributes"]["pkce.code.challenge.method"], "S256")
        for client_id in ("inout-frontend", "inout-postman"):
            scoped_client = self.admin_request("GET", "/clients?clientId=" + client_id).json()[0]
            self.assertIs(scoped_client["fullScopeAllowed"], False)
            scope_roles = self.admin_request("GET", f"/clients/{scoped_client['id']}/scope-mappings/realm").json()
            self.assertEqual({role["name"] for role in scope_roles}, {"admin", "operator"})
        self.assertEqual(set(client["attributes"]["post.logout.redirect.uris"].split("##")), {
            "http://app.fixture:3000/login", "http://app.fixture:3000/logout/complete",
        })
        console = self.client.get(ADMIN + "/admin/master/console/")
        self.assertEqual(console.status_code, 200)
        self.assertIsNone(console.headers.get("X-RateLimit-Limit-Minute"))
        self.assertIn(ADMIN, console.text, "Admin Console must advertise the separate administration origin")

    def test_frontend_roles_refresh_logout_and_provider_admin_boundary(self):
        for role in ("operator", "admin"):
            with self.subTest(role=role):
                tokens, login_claims = self.direct_sign_in(role)
                access = self.verify_token(tokens["access_token"], "inout-frontend")
                self.assert_scoped_application_claims(access, role)
                self.assertEqual(access["sub"], self.users[role]["id"])
                headers = {"Authorization": "Bearer " + tokens["access_token"]}
                for method in ("GET", "POST", "PUT", "DELETE"):
                    self.assertEqual(self.client.request(method, PUBLIC + "/admin/realms/inout/users", headers=headers).status_code, 404)
                    self.assertEqual(self.client.request(method, ISSUER + "/scim/v2/Users", headers=headers).status_code, 404)
                internal = self.client.get("http://keycloak:1105/admin/realms/inout/users", headers=headers)
                self.assertEqual(internal.status_code, 200 if role == "admin" else 403)
                if role == "admin":
                    self.assertIn("manage-users", access["resource_access"]["realm-management"]["roles"])
                refresh = self.client.post(ISSUER + "/protocol/openid-connect/token", data={
                    "grant_type": "refresh_token", "client_id": "inout-frontend", "client_secret": CLIENT_SECRET,
                    "refresh_token": tokens["refresh_token"],
                })
                self.assertEqual(refresh.status_code, 200)
                renewed = refresh.json()
                self.assertEqual(self.verify_token(renewed["id_token"], "inout-frontend").get("auth_time"), login_claims.get("auth_time"))
                self.assertEqual(self.verify_token(renewed["access_token"], "inout-frontend")["sub"], access["sub"])
                logout = self.client.post(ISSUER + "/protocol/openid-connect/revoke", data={
                    "client_id": "inout-frontend", "client_secret": CLIENT_SECRET,
                    "token_type_hint": "refresh_token", "token": renewed["refresh_token"],
                })
                self.assertEqual(logout.status_code, 200)
                after_logout = self.client.post(ISSUER + "/protocol/openid-connect/token", data={
                    "grant_type": "refresh_token", "client_id": "inout-frontend", "client_secret": CLIENT_SECRET,
                    "refresh_token": renewed["refresh_token"],
                })
                self.assertEqual(after_logout.status_code, 400, "Revocation must invalidate the app refresh session")

    def test_account_console_self_service_for_both_application_roles(self):
        for role in ("operator", "admin"):
            with self.subTest(role=role):
                tokens, _ = self.sign_in(role, "account-console")
                access = self.verify_token(tokens["access_token"], "account")
                self.assertIn("manage-account", access["resource_access"]["account"]["roles"])
                for path in ("/account/supportedLocales", "/account/?userProfileMetadata=true"):
                    response = self.client.get(ISSUER + path,
                        headers={"Accept": "application/json", "Authorization": "Bearer " + tokens["access_token"]})
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.headers.get("X-RateLimit-Limit-Minute"), "600")

    def assert_scoped_application_claims(self, access, role):
        self.assertIn(role, access["realm_access"]["roles"])
        self.assertNotIn("fixture-unrelated-role", access["realm_access"]["roles"],
            "Tokens must exclude user roles outside the client's explicit scope")
        self.assertNotIn("operator" if role == "admin" else "admin", access["realm_access"]["roles"],
            "Scope mappings must never assign a role the user does not hold")
        account_roles = access.get("resource_access", {}).get("account", {}).get("roles", [])
        self.assertTrue({"manage-account", "view-profile"}.issubset(account_roles))
        management_roles = access.get("resource_access", {}).get("realm-management", {}).get("roles", [])
        if role == "admin":
            self.assertTrue({"manage-users", "query-users", "view-users", "view-realm"}.issubset(management_roles))
        else:
            self.assertEqual(management_roles, [])

    def test_postman_preserves_scoped_api_roles_and_audience(self):
        for role in ("operator", "admin"):
            with self.subTest(role=role):
                tokens, _ = self.sign_in(role, "inout-postman")
                self.assert_scoped_application_claims(self.verify_token(tokens["access_token"], "inout-frontend"), role)

    def test_password_grant_requires_the_confidential_app_and_rejects_invalid_credentials(self):
        user = self.users["operator"]
        for client_id, secret, password, error in (
            ("inout-postman", None, user["password"], "unauthorized_client"),
            ("inout-frontend", None, user["password"], "unauthorized_client"),
            ("inout-frontend", "wrong-isolated-client-secret", user["password"], "unauthorized_client"),
            ("inout-frontend", CLIENT_SECRET, "incorrect-isolated-fixture-password", "invalid_grant"),
        ):
            with self.subTest(client=client_id, expected_error=error):
                result = self.client.post(ISSUER + "/protocol/openid-connect/token", data={
                    "grant_type": "password", "client_id": client_id, "username": user["username"], "password": password,
                    **({"client_secret": secret} if secret is not None else {}),
                })
                self.assertIn(result.status_code, (400, 401))
                self.assertEqual(result.json()["error"], error)

    def test_disabled_accounts_cannot_use_the_app_password_grant(self):
        username = "fixture-disabled-" + secrets.token_hex(4)
        password = strong_password()
        created = self.admin_request("POST", "/users", json={
            "username": username, "enabled": False, "email": username + "@example.invalid",
            "firstName": "Disabled", "lastName": "Fixture", "emailVerified": True,
            "requiredActions": [], "credentials": [{"type": "password", "value": password, "temporary": False}],
        })
        self.assertEqual(created.status_code, 201)
        user_id = created.headers["location"].rsplit("/", 1)[1]
        try:
            rejected = self.client.post(ISSUER + "/protocol/openid-connect/token", data={
                "grant_type": "password", "client_id": "inout-frontend", "client_secret": CLIENT_SECRET,
                "username": username, "password": password, "scope": "openid profile email",
            })
            self.assertEqual(rejected.status_code, 400)
            self.assertEqual(rejected.json().get("error"), "invalid_grant")
            for claim in ("access_token", "id_token", "refresh_token"):
                self.assertNotIn(claim, rejected.json(), "Disabled accounts must receive no session credentials")
        finally:
            self.admin_request("DELETE", "/users/" + user_id).raise_for_status()

    def test_builtin_account_setup_retains_recovery_and_requires_pkce(self):
        params = {"client_id": "inout-frontend", "redirect_uri": CALLBACK, "response_type": "code",
            "scope": "openid", "state": secrets.token_urlsafe(16), "nonce": secrets.token_urlsafe(16), "prompt": "login"}
        # Enforcing S256 must reject a code request that omits the challenge.
        missing_pkce = self.client.get(ISSUER + "/protocol/openid-connect/auth", params=params)
        if missing_pkce.status_code in (302, 303):
            self.assertEqual(parse_qs(urlparse(missing_pkce.headers["location"]).query).get("error"), ["invalid_request"])
        else:
            self.assertEqual(missing_pkce.status_code, 400)
        verifier = secrets.token_urlsafe(32)
        params.update(code_challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode(),
            code_challenge_method="S256")
        with httpx.Client(timeout=20, follow_redirects=False, trust_env=False) as browser:
            page = browser.get(ISSUER + "/protocol/openid-connect/auth", params=params)
            self.assertEqual(page.status_code, 200)
            self.assertNotIn("/css/inout.css", page.text)
            recovery = re.search(r'href="([^"]*login-actions/reset-credentials[^\"]*)"', page.text)
            self.assertIsNotNone(recovery, "Stock forgot-password action must remain accessible")
            target = urljoin(PUBLIC, html.unescape(recovery[1]))
            self.assertEqual(urlparse(target).netloc, urlparse(PUBLIC).netloc)
            recovered = browser.get(target)
            self.assertEqual(recovered.status_code, 200)
            self.assertIn('id="kc-reset-password-form"', recovered.text)
            self.assertIn('name="username"', recovered.text)
            self.assertNotIn("/css/inout.css", recovered.text)

    def test_builtin_mfa_enrollment_then_app_form_requires_otp(self):
        username = "fixture-mfa-" + secrets.token_hex(4)
        created = self.admin_request("POST", "/users", json={"username": username, "enabled": True,
            "email": username + "@example.invalid", "firstName": "MFA", "lastName": "Fixture", "emailVerified": True,
            "requiredActions": ["CONFIGURE_TOTP"],
            "credentials": [{"type": "password", "value": strong_password(), "temporary": False}]})
        self.assertEqual(created.status_code, 201)
        user_id = created.headers["location"].rsplit("/", 1)[1]
        password = strong_password()
        try:
            self.admin_request("PUT", f"/users/{user_id}/reset-password", json={
                "type": "password", "value": password, "temporary": False}).raise_for_status()
            self.users["mfa"] = {"id": user_id, "username": username, "password": password}
            incomplete = self.client.post(ISSUER + "/protocol/openid-connect/token", data={
                "grant_type": "password", "client_id": "inout-frontend", "client_secret": CLIENT_SECRET,
                "username": username, "password": password, "scope": "openid profile email",
            })
            self.assertEqual(incomplete.status_code, 400, "App login must not bypass mandatory OTP enrollment")
            self.assertEqual(incomplete.json().get("error"), "invalid_grant")
            self.assertEqual(incomplete.json().get("error_description"), "Account is not fully set up")
            self.sign_in("mfa", configure_otp=True)
            user = self.users["mfa"]
            while int(time.time()) // 30 <= user.get("last_otp_counter", -1):
                time.sleep(0.25)
            # Prove valid OTP authentication before intentionally failing login.
            # The realm's quick-login protection can delay a later valid attempt;
            # tests must not weaken or bypass that production defense.
            self.direct_sign_in("mfa", self.otp_code(user["otp_secret"]))
            for code in (None, "invalid-otp"):
                result = self.client.post(ISSUER + "/protocol/openid-connect/token", data={
                    "grant_type": "password", "client_id": "inout-frontend", "client_secret": CLIENT_SECRET,
                    "username": username, "password": password, **({"totp": code} if code is not None else {}),
                })
                self.assertIn(result.status_code, (400, 401), "Enrolled accounts require a valid OTP in the app form")
                self.assertEqual(result.json()["error"], "invalid_grant")
        finally:
            self.admin_request("DELETE", "/users/" + user_id).raise_for_status()
            self.users.pop("mfa", None)

    def test_wrong_password_has_generic_error_and_preserves_recovery(self):
        errors = []
        for username in (self.users["operator"]["username"], "fixture-user-does-not-exist"):
            with httpx.Client(timeout=20, follow_redirects=False, trust_env=False) as browser:
                page = browser.get(ISSUER + "/protocol/openid-connect/auth", params={
                    "client_id": "inout-frontend", "redirect_uri": CALLBACK, "response_type": "code", "scope": "openid",
                    "state": secrets.token_urlsafe(16), "nonce": secrets.token_urlsafe(16), "prompt": "login",
                    "code_challenge": base64.urlsafe_b64encode(hashlib.sha256(secrets.token_bytes(32)).digest()).rstrip(b"=").decode(),
                    "code_challenge_method": "S256"})
                self.assertEqual(page.status_code, 200)
                form = re.search(r'<form\b[^>]*id="kc-form-login"[^>]*>', page.text)
                action = html.unescape(re.search(r'action="([^"]+)"', form[0])[1])
                rejected = browser.post(action, data={"username": username, "password": "incorrect-isolated-fixture-password", "credentialId": ""})
                self.assertEqual(rejected.status_code, 200)
                self.assertIn('id="kc-form-login"', rejected.text)
                self.assertIn("login-actions/reset-credentials", rejected.text)
                error = re.search(r'class="[^"]*kc-feedback-text[^\"]*"[^>]*>(.*?)</span>', rejected.text, re.S)
                self.assertIsNotNone(error, "Provider must display a validation error")
                errors.append(html.unescape(error[1]).strip())
        self.assertEqual(errors[0], errors[1], "An unknown account and an incorrect password must have the same message")

    def test_password_policy_rejects_short_credentials_at_the_provider(self):
        realm = self.admin_request("GET", "").json()
        password_policy = realm.get("passwordPolicy", "")
        self.assertIn("length(8)", password_policy)
        self.assertIn("upperCase(1)", password_policy)
        self.assertIn("lowerCase(1)", password_policy)
        self.assertIn("digits(1)", password_policy)
        self.assertIn("specialChars(1)", password_policy)
        user = self.users["operator"]
        rejected = self.admin_request("PUT", f"/users/{user['id']}/reset-password", json={
            "type": "password", "value": "x", "temporary": False,
        })
        self.assertEqual(rejected.status_code, 400, "Provider must enforce the application's minimum")
        # Rejection must preserve the existing strong password and login.
        self.sign_in("operator")
        self.admin_request("PUT", f"/users/{user['id']}/reset-password", json={
            "type": "password", "value": user["password"], "temporary": True,
        }).raise_for_status()
        incomplete = self.client.post(ISSUER + "/protocol/openid-connect/token", data={
            "grant_type": "password", "client_id": "inout-frontend", "client_secret": CLIENT_SECRET,
            "username": user["username"], "password": user["password"],
        })
        self.assertEqual(incomplete.status_code, 400, "App login must not bypass required password updates")
        self.assertEqual(incomplete.json()["error"], "invalid_grant")
        self.assertEqual(incomplete.json().get("error_description"), "Account is not fully set up",
            "Only this valid-credentials required-action response may offer account setup")
        self.sign_in("operator", password_update=strong_password())
        self.direct_sign_in("operator")


if __name__ == "__main__":
    unittest.main(verbosity=2)
