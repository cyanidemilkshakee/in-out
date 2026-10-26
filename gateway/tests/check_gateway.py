import asyncio
import http.client
import ssl
import time
import unittest
import uuid
import httpx

class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.actor = uuid.uuid4().hex

    def auth(self, actor=None, token=1, **headers):
        return {'Authorization': f'Bearer fixture-account-{actor or self.actor}-token-{token}', **headers}

    def summary(self, response):
        # Upstream fixtures echo headers. Keep tokens and trusted secrets out
        # of unittest assertion output.
        return f'status={response.status_code}, content_type={response.headers.get("Content-Type", "")}, bytes={len(response.content)}'

    def avoid_minute_boundary(self, margin=5):
        # Kong's native fixed windows legitimately reset on a UTC minute.
        # Keep the small quota proof within one window rather than asserting
        # that a reset is a limiter failure. Wait only near the boundary.
        remaining = 60 - time.time() % 60
        if remaining < margin:
            time.sleep(remaining + 0.1)

    def set_identity_state(self, client, account=None, **state):
        response = client.post('http://python-api:1102/__fixture/identity-state',
            headers={'X-Inout-Gateway-Secret': 'fixture-identity-secret-not-for-production-12345'},
            json={'account': account or self.actor, **state})
        self.assertEqual(response.status_code, 204, self.summary(response))

    def test_slow_upload_has_total_deadline_for_fixed_and_chunked_bodies(self):
        with httpx.Client(timeout=5) as client:
            before = client.get('http://kong:8002/__fixture/body-count', headers=self.auth()).json()['contacts']
        for chunked, crowded in ((False, False), (True, False), (False, True), (True, True)):
            with self.subTest(chunked=chunked, crowded=crowded):
                connection = http.client.HTTPConnection('kong', 8002, timeout=5)
                try:
                    connection.putrequest('POST', '/v1/deadline-probe')
                    connection.putheader('Content-Type', 'application/json')
                    connection.putheader('Authorization', 'Bearer fixture-valid')
                    if crowded:
                        # Keep the socket-derived routing field early in the
                        # table while placing body metadata beyond Lua's cap.
                        connection.putheader('InoutListener', 'spoofed')
                        for index in range(110):
                            connection.putheader(f'X-Filler-{index}', 'x')
                    connection.putheader('Transfer-Encoding' if chunked else 'Content-Length', 'chunked' if chunked else '8')
                    connection.endheaders()
                    connection.send(b'1\r\n{\r\n' if chunked else b'{')
                    # A single bounded fixture request crosses the one-second
                    # test deadline without exceeding the idle timeout.
                    began = time.monotonic()
                    time.sleep(1.2)
                    try:
                        response = connection.getresponse()
                        self.assertEqual(response.status, 408, 'Slow upload response changed')
                    except http.client.RemoteDisconnected:
                        # Cancelling an outstanding native body reader can
                        # close HTTP/1 before an error response is flushed.
                        pass
                    self.assertLess(time.monotonic() - began, 3)
                finally:
                    connection.close()
        with httpx.Client(timeout=5) as client:
            self.assertEqual(client.get('http://kong:8002/__fixture/body-count', headers=self.auth()).json()['contacts'], before)

    def test_listener_routing_headers_and_authentication(self):
        with httpx.Client(timeout=10) as client:
            for port, upstream in ((8000, 3000), (8002, 1102), (8005, 1105), (8006, 1105)):
                path = '/realms/inout/example' if port == 8005 else '/example'
                response = client.get(f'http://kong:{port}{path}?eventId=EVT-000123', headers={
                    'Host': 'localhost:1008', 'Authorization': 'Bearer fixture-valid',
                    'Idempotency-Key': 'test-retry-key', 'X-Client-Verify': 'SUCCESS',
                    'X-Client-DN': 'CN=spoof', 'X-Proxy-Secret': 'spoof',
                    'X-Inout-Terminal-DN': 'CN=spoof', 'X-Inout-Gateway-Secret': 'spoof',
                    'InoutListener': '8443',
                    'X-Forwarded-Host': 'attacker.invalid', 'X-Forwarded-Proto': 'https'})
                self.assertEqual(response.status_code, 200, self.summary(response))
                self.assertEqual(response.json()['port'], upstream)
                self.assertEqual(response.json()['path'], f'{path}?eventId=EVT-000123')
                headers = response.json()['headers']
                self.assertTrue(headers['authorization'] == 'Bearer fixture-valid', 'Bearer forwarding changed')
                self.assertEqual(headers['idempotency-key'], 'test-retry-key')
                self.assertNotIn('attacker.invalid', headers.get('x-forwarded-host', ''))
                self.assertEqual(headers['x-forwarded-proto'], 'http')
                self.assertFalse('inoutlistener' in headers, 'Internal listener header was forwarded')
                for name in ('x-client-verify', 'x-client-dn', 'x-proxy-secret', 'x-inout-terminal-dn', 'x-inout-gateway-secret'):
                    self.assertFalse(name in headers, f'Untrusted header {name} was forwarded')
                self.assertIn('x-request-id', response.headers)
            self.assertEqual(client.get('http://kong:8002/v1/protected').status_code, 401)
            self.assertEqual(client.get('http://kong:8002/v1/protected', headers={'Authorization':'Bearer fixture-valid'}).status_code, 200)
            with self.assertRaises(httpx.ConnectError):
                client.get('http://kong:8001/')

    def test_gateway_metrics_are_available_only_on_private_status_listener(self):
        with httpx.Client(timeout=10) as client:
            proxied = client.get('http://kong:8000/metrics-fixture')
            self.assertEqual(proxied.status_code, 200, self.summary(proxied))
            metrics = client.get('http://kong:8100/metrics')
            self.assertEqual(metrics.status_code, 200, self.summary(metrics))
            body = metrics.text
            self.assertIn('kong_http_requests_total', body)
            self.assertRegex(body, r'kong_http_requests_total\{[^\n]*code="200"')
            self.assertIn('kong_upstream_latency_ms', body)
            with self.assertRaises(httpx.ConnectError):
                client.get('http://kong:8001/metrics')

    def test_provider_admin_api_is_only_reachable_through_maintenance_or_internal_routes(self):
        # Send raw paths so the client does not remove dot segments before
        # Kong receives them. A 404 must come from the gateway, never fixture.
        denied_paths = (
            '/', '/admin', '/admin/', '/admin/realms/inout/users',
            '/Admin/realms/inout/users', '//admin/realms/inout/users',
            '/%61dmin/realms/inout/users', '/%2561dmin/realms/inout/users',
            '/%2fadmin/realms/inout/users', '/admin;ignored/realms/inout/users',
            '/admin%3bignored/realms/inout/users', '/admin%253bignored/realms/inout/users',
            '/realms/../admin/realms/inout/users', '/realms/%2e%2e/admin/realms/inout/users',
            '/resources/..;/admin/realms/inout/users', '/.well-known/%2e%2e/admin/realms/inout/users',
            '/realms%2finout%2f..%2f..%2fadmin/realms/inout/users',
            '/realms\\..\\admin/realms/inout/users', '/realms/%5c..%5cadmin/realms/inout/users',
            '/realms/inout/scim', '/realms/inout/scim/v2/Users', '/realms/inout/%73cim/v2/Users',
            '/realms/inout/SCIM/v2/Users',
            '/health/ready', '/metrics',
        )
        for path in denied_paths:
            with self.subTest(path=path):
                connection = http.client.HTTPConnection('kong', 8005, timeout=10)
                try:
                    connection.request('GET', path, headers={
                        'Authorization': 'Bearer fixture-valid', 'InoutListener': '8006',
                        'Host': 'auth.localhost:1009', 'X-Forwarded-Port': '8006'})
                    response = connection.getresponse()
                    body = response.read()
                    self.assertEqual(response.status, 404, f'response bytes={len(body)}')
                    self.assertFalse(b'"port":' in body, 'Blocked calls must not reach Keycloak')
                finally:
                    connection.close()
        with httpx.Client(timeout=10) as client:
            for path in ('/realms/inout/.well-known/openid-configuration',
                         '/realms/inout/protocol/openid-connect/auth?redirect_uri=http://localhost/admin',
                         '/realms/inout/protocol/openid-connect/token', '/realms/inout/account/',
                         '/resources/version/login/keycloak/style.css', '/.well-known/openid-configuration'):
                response = client.get(f'http://kong:8005{path}')
                self.assertEqual(response.status_code, 200, self.summary(response))
                self.assertEqual(response.json()['port'], 1105)
            for base in ('http://kong:8006', 'http://keycloak:1105'):
                response = client.get(f'{base}/admin/realms/inout/users',
                    headers={'Authorization': 'Bearer fixture-valid'})
                self.assertEqual(response.status_code, 200, self.summary(response))
                self.assertEqual(response.json()['port'], 1105)
                self.assertEqual(client.get(f'{base}/realms/inout/scim/v2/Users').status_code, 200)
            # The application's own admin pages and API stay accessible.
            self.assertEqual(client.get('http://kong:8000/admin/users').status_code, 200)
            self.assertEqual(client.get('http://kong:8002/v1/admin/profile', headers=self.auth()).status_code, 200)

    def test_chunked_auth_session_request_and_response_headers(self):
        # A session carrying identity-provider tokens can cross Node's default
        # 16 KiB request limit and Nginx's former 16 KiB upstream header buffer.
        cookie = '; '.join(f'authjs.session-token.{index}=' + str(index) * 3500
            for index in range(6))
        self.assertGreater(len(cookie.encode()), 16384)
        self.assertLess(len(cookie.encode()), 32768)
        with httpx.Client(timeout=10) as client:
            response = client.get('http://kong:8000/api/auth/fixture-session',
                headers={'Cookie': cookie})
        self.assertEqual(response.status_code, 200, self.summary(response))
        self.assertEqual(response.json()['headers']['cookie'], cookie)
        chunks = response.headers.get_list('set-cookie')
        self.assertEqual(len(chunks), 6)
        self.assertGreater(sum(len(chunk.encode()) for chunk in chunks), 16384)
        for index, chunk in enumerate(chunks):
            self.assertLessEqual(len(chunk.encode()), 4096)
            self.assertEqual(chunk, f'authjs.session-token.{index}='
                + str(index) * 3500 + '; Path=/; HttpOnly; SameSite=Lax')

    def test_public_identity_login_aliases_are_rejected_before_upstream(self):
        paths = (
            '/%72ealms/inout/login-actions/authenticate',
            '/realms/inout/login%2dactions/authenticate',
            '/realms%2finout%2flogin-actions/authenticate',
            '/realms%252finout%252flogin-actions/authenticate',
            '/realms/inout//login-actions/authenticate',
            '/realms/inout/./login-actions/authenticate',
            '/realms/inout/x/../login-actions/authenticate',
            '/realms/inout/login-actions;ignored/authenticate',
            '/realms/inout/login-actions%3bignored/authenticate',
            '/realms/inout\\login-actions\\authenticate',
            '/realms/inout/login-actions/%01authenticate',
        )
        with httpx.Client(timeout=10) as client:
            before = client.get('http://keycloak:1105/__fixture/body-count').json()['contacts']
        for path in paths:
            with self.subTest(path=path):
                connection = http.client.HTTPConnection('kong', 8005, timeout=10)
                try:
                    connection.request('POST', path + '?session_code=fixture&execution=fixture',
                        body=b'username=synthetic&password=synthetic', headers={
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Host': 'auth.localhost:8006', 'InoutListener': '8006',
                            'X-Forwarded-For': '203.0.113.99'})
                    response = connection.getresponse()
                    body = response.read()
                    self.assertEqual(response.status, 400, f'response bytes={len(body)}')
                    self.assertFalse(b'"port":' in body, 'Ambiguous identity login path reached upstream')
                finally:
                    connection.close()
        with httpx.Client(timeout=10) as client:
            self.assertEqual(client.get('http://keycloak:1105/__fixture/body-count').json()['contacts'], before)

    def test_public_identity_login_posts_share_strict_budget_and_preserve_oidc_reads(self):
        self.avoid_minute_boundary(margin=25)
        spoofed = {'Host': 'auth.localhost:8006', 'InoutListener': '8006',
            'X-Forwarded-Port': '8006', 'X-Forwarded-For': '203.0.113.77',
            'X-Real-IP': '198.51.100.88', 'X-Consumer-ID': 'forged-login-account'}
        before = httpx.get('http://keycloak:1105/__fixture/body-count').json()['contacts']

        async def burst():
            async with httpx.AsyncClient(timeout=10) as client:
                # Warm both peers before the fixed second-window assertion.
                for peer in ('kong', 'kong-peer'):
                    self.assertEqual((await client.get(f'http://{peer}:8005/realms/inout/protocol/openid-connect/auth',
                        headers=spoofed)).status_code, 200)
                while time.time() % 1 > 0.10:
                    await asyncio.sleep(0.02)
                async def request(index):
                    peer = 'kong' if index % 2 else 'kong-peer'
                    return await client.post(f'http://{peer}:8005/realms/inout/login-actions/authenticate?session_code=fixture{index}',
                        headers={**spoofed, 'X-Forwarded-For': f'203.0.113.{index + 1}'},
                        data={'username': 'synthetic', 'password': 'synthetic'})
                return await asyncio.gather(*(request(index) for index in range(6)))
        responses = asyncio.run(burst())
        self.assertEqual([response.status_code for response in responses].count(200), 5)
        self.assertEqual([response.status_code for response in responses].count(429), 1)
        for response in responses:
            self.assertEqual(response.headers.get('X-RateLimit-Limit-Minute'), '60')
            self.assertEqual(response.headers.get('X-RateLimit-Limit-Second'), '5')
        time.sleep(1.05)
        paths = ('/realms/inout/login-actions/authenticate',
            '/realms/inout/login-actions/required-action', '/realms/inout/login-actions/reset-credentials',
            '/realms/inout/login-actions/registration', '/realms/other-fixture/login-actions/authenticate',
            '/realms/inout/login-actions/authenticate/')
        with httpx.Client(timeout=10) as client:
            # Six burst attempts (including its rejection) used six of60.
            for index in range(54):
                peer = 'kong' if index % 2 else 'kong-peer'
                path = paths[index % len(paths)] + f'?session_code=fixture{index}&execution=fixture-execution&client_id=inout-frontend&tab_id=fixture%2Btab'
                response = client.post(f'http://{peer}:8005' + path,
                    headers={**spoofed, 'X-Forwarded-For': f'198.51.100.{index + 1}'},
                    data={'username': 'synthetic', 'password': 'synthetic'})
                self.assertEqual(response.status_code, 200, self.summary(response))
                self.assertEqual(response.headers.get('X-RateLimit-Limit-Minute'), '60')
                self.assertEqual(response.json()['path'], path)
                time.sleep(0.24)
            blocked = client.post('http://kong-peer:8005/realms/inout/login-actions/authenticate?session_code=new-fixture',
                headers=spoofed, data={'username': 'synthetic', 'password': 'synthetic'})
            self.assertEqual(blocked.status_code, 429, self.summary(blocked))
            self.assertTrue(blocked.headers['Retry-After'].isdigit())
            self.assertFalse('"port":' in blocked.text, 'Throttled credential form reached upstream')
            for path in ('/realms/inout/login-actions/authenticate?session_code=issued-fixture',
                '/realms/inout/protocol/openid-connect/auth', '/realms/inout/.well-known/openid-configuration',
                '/resources/version/login/keycloak/style.css'):
                response = client.get('http://kong:8005' + path, headers=spoofed)
                self.assertEqual(response.status_code, 200, self.summary(response))
                self.assertEqual(response.headers.get('X-RateLimit-Limit-Minute'), '64')
            exchange = client.post('http://kong:8005/realms/inout/protocol/openid-connect/token',
                headers=spoofed, data={'grant_type': 'authorization_code', 'code': 'synthetic'})
            self.assertEqual(exchange.status_code, 200, self.summary(exchange))
            self.assertEqual(exchange.headers.get('X-RateLimit-Limit-Minute'), '64')
            self.assertEqual(client.get('http://keycloak:1105/__fixture/body-count').json()['contacts'], before + 60)
        connection = http.client.HTTPConnection('kong', 8005, timeout=5)
        try:
            connection.putrequest('POST', '/realms/inout/login-actions/authenticate?session_code=fixture')
            connection.putheader('Content-Length', '100')
            connection.endheaders()
            response = connection.getresponse()
            self.assertEqual(response.status, 429)
            self.assertIsNotNone(response.getheader('Retry-After'))
            response.read()
        finally:
            connection.close()

    def test_request_header_limit_remains_bounded(self):
        # Each field must fit within one 32 KiB large-header buffer. Raising
        # the auth allowance must not remove that gateway boundary.
        with httpx.Client(timeout=10) as client:
            response = client.get('http://kong:8000/api/auth/fixture-session',
                headers={'Cookie': 'authjs.session-token=' + 'x' * 32768})
        self.assertIn(response.status_code, (400, 431), self.summary(response))

    def test_http_cannot_spoof_terminal_identity(self):
        for port in (8000, 8002, 8005):
            response = httpx.post(f'http://kong:{port}/v1/scans', headers={
                'X-Client-Verify':'SUCCESS', 'X-Client-DN':'CN=terminal-test',
                'X-Inout-Terminal-DN':'CN=terminal-test',
                'X-Inout-Gateway-Secret':'gateway-test-secret-not-for-production-12345'})
            self.assertEqual(response.status_code, 404 if port == 8005 else 401)

    def test_api_raw_path_aliases_cannot_bypass_operation_group_routes(self):
        paths = (
            '/v1/%70ermission-requests', '/v1%2fpermission-requests',
            '/v1%252fpermission-requests', '/v1/./permission-requests',
            '/v1/x/../permission-requests', '/v1//permission-requests',
            '/v1/permission-requests;ignored', '/v1\\permission-requests',
            '/v1/%01permission-requests',
        )
        for path in paths:
            with self.subTest(path=path):
                # Raw HTTP preserves aliases that higher-level clients remove.
                connection = http.client.HTTPConnection('kong', 8002, timeout=10)
                try:
                    connection.request('POST', path, headers=self.auth())
                    response = connection.getresponse()
                    body = response.read()
                    self.assertEqual(response.status, 400, f'response bytes={len(body)}')
                    self.assertFalse(b'"port":' in body, 'Ambiguous path reached upstream')
                finally:
                    connection.close()
        with httpx.Client(timeout=10) as client:
            response = client.get('http://kong:8002/v1/permission-requests?reason=%2F%3B%5C%20test',
                headers=self.auth())
            self.assertEqual(response.status_code, 200, self.summary(response))
            self.assertEqual(response.json()['path'], '/v1/permission-requests?reason=%2F%3B%5C%20test')
        context = ssl.create_default_context(cafile='/certificates/ca.crt')
        context.load_cert_chain('/certificates/client.crt', '/certificates/client.key')
        connection = http.client.HTTPSConnection('kong', 8443, timeout=10, context=context)
        try:
            connection.request('POST', '/v1/%73cans')
            response = connection.getresponse()
            body = response.read()
            self.assertEqual(response.status, 400, f'response bytes={len(body)}')
            self.assertFalse(b'"port":' in body, 'Ambiguous terminal path reached upstream')
        finally:
            connection.close()

    def test_mtls_accepts_only_trusted_current_certificates(self):
        for certificate in (None, 'untrusted', 'expired', 'client'):
            context = ssl.create_default_context(cafile='/certificates/ca.crt')
            if certificate:
                context.load_cert_chain(f'/certificates/{certificate}.crt', f'/certificates/{certificate}.key')
            with httpx.Client(verify=context, timeout=10) as client:
                response = client.post('https://kong:8443/v1/scans', headers={'X-Inout-Terminal-DN':'CN=spoof'})
                if certificate == 'client':
                    self.assertEqual(response.status_code, 200, self.summary(response))
                    self.assertEqual(response.json()['headers']['x-inout-terminal-dn'], 'CN=terminal-test')
                    self.assertTrue(response.json()['headers']['x-inout-gateway-secret'] == 'gateway-test-secret-not-for-production-12345', 'Trusted terminal gateway secret changed')
                    self.assertEqual(client.get('https://kong:8443/admin').status_code, 404)
                else:
                    self.assertGreaterEqual(response.status_code, 400)

    def test_api_body_limit_including_chunked_requests(self):
        for body in (b'x' * 262145, iter([b'x' * 131073, b'x' * 131073])):
            response = httpx.post('http://kong:8002/v1/example', content=body, headers=self.auth())
            self.assertEqual(response.status_code, 413, self.summary(response))

    def test_events_are_not_buffered(self):
        for port, path in ((8000, '/api/presence'), (8002, '/v1/presence/stream')):
            with httpx.stream('GET', f'http://kong:{port}{path}', timeout=10, headers=self.auth()) as response:
                # Measure delivery after headers; cold Docker DNS is unrelated to buffering.
                started = time.monotonic()
                self.assertEqual(response.status_code, 200)
                lines = response.iter_lines()
                self.assertEqual(next(lines), ': heartbeat')
                self.assertLess(time.monotonic() - started, 2)
                self.assertEqual(next(lines), '')
                self.assertEqual(next(lines), 'data: {"state":"inside"}')
                self.assertGreater(time.monotonic() - started, 2)

    def test_shared_app_address_does_not_exhaust_an_ip_budget_for_other_sessions(self):
        # Every synthetic account comes from the same BFF-style socket peer.
        # Their aggregate exceeds the fixture's eight/account allowance.
        async def burst():
            semaphore = asyncio.Semaphore(8)
            async with httpx.AsyncClient(timeout=20) as client:
                async def request(account):
                    async with semaphore:
                        return (await client.get('http://kong:8002/limit', headers=self.auth(account))).status_code
                accounts = [uuid.uuid4().hex for _ in range(16)]
                return await asyncio.gather(*(request(account) for account in accounts for _ in range(2)))
        self.assertEqual(set(asyncio.run(burst())), {200})

    def test_account_quota_shared_across_token_rotation_reads_and_writes(self):
        self.avoid_minute_boundary()
        with httpx.Client(timeout=10) as client:
            for index in range(8):
                method = 'GET' if index % 2 == 0 else 'POST'
                path = '/limit' if method == 'GET' else '/v1/terminal/scans'
                response = client.request(method, f'http://kong:8002{path}',
                    headers=self.auth(token=index % 2 + 1))
                self.assertEqual(response.status_code, 200, self.summary(response))
            blocked = client.get('http://kong:8002/limit', headers=self.auth(token=3))
        self.assertEqual(blocked.status_code, 429, self.summary(blocked))
        self.assertGreaterEqual(int(blocked.headers['Retry-After']), 1)
        self.assertLessEqual(int(blocked.headers['Retry-After']), 60)
        self.assertFalse('"port":' in blocked.text, 'Rejected work must not reach the API fixture')

    def test_spoofed_identity_headers_cannot_select_another_account_allowance(self):
        self.avoid_minute_boundary()
        other = uuid.uuid4().hex
        with httpx.Client(timeout=10) as client:
            for _ in range(8):
                self.assertEqual(client.get('http://kong:8002/limit', headers=self.auth()).status_code, 200)
            spoofed = self.auth(token=4, **{
                'X-Inout-Limit-Identity': other, 'X-Consumer-ID': other,
                'X-Consumer-Username': other, 'X-Credential-Identifier': other,
                'X-Inout-Gateway-Secret': 'fixture-identity-secret-not-for-production-12345',
                'X-Inout-Terminal-DN': 'CN=another-terminal', 'X-Forwarded-For': '203.0.113.77',
            })
            blocked = client.get('http://kong:8002/limit', headers=spoofed)
            independent = client.get('http://kong:8002/limit', headers=self.auth(other))
        self.assertEqual(blocked.status_code, 429, self.summary(blocked))
        self.assertEqual(independent.status_code, 200, self.summary(independent))

    def test_concurrent_kong_peers_share_one_atomic_credential_allowance(self):
        self.avoid_minute_boundary()
        async def burst():
            async with httpx.AsyncClient(timeout=20) as client:
                async def request(index):
                    peer = 'kong' if index % 2 else 'kong-peer'
                    return (await client.get(f'http://{peer}:8002/limit',
                        headers=self.auth(token=index % 3 + 1))).status_code
                return await asyncio.gather(*(request(index) for index in range(24)))
        statuses = asyncio.run(burst())
        self.assertEqual(statuses.count(200), 8, statuses)
        self.assertEqual(statuses.count(429), 16, statuses)

    def test_forged_bearer_and_identity_headers_cannot_create_a_verified_credential(self):
        response = httpx.get('http://kong:8002/limit', headers={
            'Authorization': 'Bearer forged-subject', 'X-Consumer-ID': self.actor,
            'X-Inout-Limit-Identity': self.actor,
            'X-Inout-Gateway-Secret': 'fixture-identity-secret-not-for-production-12345'})
        self.assertEqual(response.status_code, 401, self.summary(response))
        self.assertFalse('"port":' in response.text, 'Invalid credentials must not reach the API fixture')

    def test_cached_identity_is_not_resurrected_when_verifier_becomes_unavailable(self):
        with httpx.Client(timeout=10) as client:
            self.set_identity_state(client, status=200, expires_at=time.time() + 300)
            warm = client.get('http://kong:8002/limit', headers=self.auth())
            self.assertEqual(warm.status_code, 200, self.summary(warm))
            self.set_identity_state(client, status=503, expires_at=time.time() + 300)
            # The valid positive cache remains usable within its two-second
            # fixture TTL, but an outage may never extend that deadline.
            cached = client.get('http://kong:8002/limit', headers=self.auth())
            self.assertEqual(cached.status_code, 200, self.summary(cached))
            time.sleep(2.2)
            unavailable = client.get('http://kong:8002/limit', headers=self.auth())
        self.assertEqual(unavailable.status_code, 503, self.summary(unavailable))
        self.assertFalse('"port":' in unavailable.text, 'Stale identity must not reach the API fixture')

    def test_expired_token_cannot_reuse_cached_identity(self):
        with httpx.Client(timeout=10) as client:
            self.set_identity_state(client, status=200, expires_at=time.time() + 1.2)
            warm = client.get('http://kong:8002/limit', headers=self.auth())
            self.assertEqual(warm.status_code, 200, self.summary(warm))
            time.sleep(1.4)
            expired = client.get('http://kong:8002/limit', headers=self.auth())
        self.assertEqual(expired.status_code, 401, self.summary(expired))
        self.assertEqual(expired.headers.get('WWW-Authenticate'), 'Bearer')
        self.assertFalse('"port":' in expired.text, 'Expired identity must not reach the API fixture')

    def test_operation_groups_share_limits_across_endpoints_and_record_ids(self):
        groups = (
            (60, 10, '/v1/permission-requests', (
                ('POST', '/v1/permissions/grant'), ('POST', '/v1/permission-requests'),
                ('POST', '/v1/registry/subjects'), ('PATCH', '/v1/registry/subjects/{record}'),
                ('POST', '/v1/alerts/{record}/review'),
                ('POST', '/v1/permission-requests/{record}/decide'),
                ('POST', '/v1/terminal/manual-reviews'))),
            (20, 5, '/v1/keycloak/users', (
                ('POST', '/v1/keycloak/users'), ('PUT', '/v1/keycloak/users/{record}'),
                ('DELETE', '/v1/keycloak/users/{record}'), ('POST', '/v1/checkpoints'))),
            (20, 5, '/v1/alerts', (
                ('POST', '/v1/alerts/evaluate'), ('POST', '/v1/alert-warnings/{record}/reset'),
                ('POST', '/v1/alerts/{record}/release-entry-restriction'),
                ('PUT', '/v1/alert-rule-assignments/{record}'))),
        )
        with httpx.Client(timeout=10) as client:
            for minute, second, read_path, actions in groups:
                with self.subTest(minute=minute, read_path=read_path):
                    self.avoid_minute_boundary(margin=15)
                    actor = uuid.uuid4().hex
                    for index in range(minute):
                        method, path = actions[index % len(actions)]
                        peer = 'kong' if index % 2 else 'kong-peer'
                        response = client.request(method,
                            f'http://{peer}:8002' + path.format(record=uuid.uuid4().hex),
                            headers=self.auth(actor, token=index % 2 + 1))
                        self.assertEqual(response.status_code, 200, self.summary(response))
                        self.assertEqual(response.headers.get('X-RateLimit-Limit-Minute'), str(minute))
                        self.assertEqual(response.headers.get('X-RateLimit-Limit-Second'), str(second))
                        # Stay below the real per-second budget to isolate the
                        # shared per-minute group counter across both peers.
                        time.sleep(1.25 / second)
                    method, path = actions[-1]
                    blocked = client.request(method,
                        'http://kong:8002' + path.format(record=uuid.uuid4().hex),
                        headers=self.auth(actor, token=3))
                    self.assertEqual(blocked.status_code, 429, self.summary(blocked))
                    self.assertGreaterEqual(int(blocked.headers['Retry-After']), 1)
                    self.assertFalse('"port":' in blocked.text, 'Rejected group action reached upstream')
                    independent = client.request(method,
                        'http://kong-peer:8002' + path.format(record=uuid.uuid4().hex),
                        headers=self.auth(uuid.uuid4().hex))
                    self.assertEqual(independent.status_code, 200, self.summary(independent))
                    read = client.get('http://kong:8002' + read_path, headers=self.auth(actor))
                    self.assertEqual(read.status_code, 200, self.summary(read))
                    self.assertEqual(read.headers.get('X-RateLimit-Limit-Minute'), '8')

    def test_web_login_path_aliases_are_rejected_before_upstream(self):
        paths = (
            '/api/auth/call%62ack/keycloak', '/%61pi/auth/callback/keycloak',
            '/api%2fauth/callback/keycloak', '/api%252fauth/callback/keycloak',
            '/api/auth//signin/keycloak', '//api/auth/signin/keycloak',
            '/api/auth/./signin/keycloak', '/api/auth/x/../signin/keycloak',
            '/api/auth/signin;ignored/keycloak', '/api/auth/signin%3bignored/keycloak',
            '/api/auth\\signin\\keycloak', '/api/auth/signin/%01keycloak',
            '/%6cogin', '/x/../login', '/login;ignored', '/login//',
        )
        with httpx.Client(timeout=10) as client:
            before = client.get('http://app:3000/__fixture/body-count').json()['contacts']
        for path in paths:
            with self.subTest(path=path):
                connection = http.client.HTTPConnection('kong', 8000, timeout=10)
                try:
                    connection.request('POST', path, body=b'csrfToken=fixture', headers={
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Host': 'localhost:8002', 'InoutListener': '8002',
                        'X-Forwarded-For': '203.0.113.99'})
                    response = connection.getresponse()
                    body = response.read()
                    self.assertEqual(response.status, 400, f'response bytes={len(body)}')
                    self.assertFalse(b'"port":' in body, 'Ambiguous login path reached upstream')
                finally:
                    connection.close()
        with httpx.Client(timeout=10) as client:
            self.assertEqual(client.get('http://app:3000/__fixture/body-count').json()['contacts'], before)

    def test_web_login_post_budget_is_shared_and_keeps_get_auth_flows_available(self):
        self.avoid_minute_boundary(margin=15)
        spoofed = {'Host': 'localhost:8002', 'InoutListener': '8006',
            'X-Forwarded-Port': '8006', 'X-Forwarded-For': '203.0.113.77',
            'X-Real-IP': '198.51.100.88', 'Forwarded': 'for=192.0.2.99',
            'X-Consumer-ID': 'forged-login-account'}
        with httpx.Client(timeout=10) as client:
            before = client.get('http://app:3000/__fixture/body-count').json()['contacts']
            for path in ('/api/auth/csrf', '/api/auth/providers'):
                response = client.get('http://kong:8000' + path, headers=spoofed)
                self.assertEqual(response.status_code, 200, self.summary(response))
                self.assertEqual(response.headers.get('X-RateLimit-Limit-Minute'), '48')

        # Begin just after a second boundary, with both gateways already warm.
        # This proves a real shared socket-IP burst, not a browser header bucket.
        while time.time() % 1 > 0.10:
            time.sleep(0.02)
        async def burst():
            async with httpx.AsyncClient(timeout=10) as client:
                async def request(index):
                    peer = 'kong' if index % 2 else 'kong-peer'
                    return await client.post(f'http://{peer}:8000/api/auth/signin/keycloak?attempt={index}',
                        headers={**spoofed, 'X-Forwarded-For': f'203.0.113.{index + 1}'},
                        data={'csrfToken': 'fixture', 'callbackUrl': '/admin'})
                return await asyncio.gather(*(request(index) for index in range(4)))
        responses = asyncio.run(burst())
        self.assertEqual([response.status_code for response in responses].count(200), 3)
        self.assertEqual([response.status_code for response in responses].count(429), 1)
        for response in responses:
            self.assertEqual(response.headers.get('X-RateLimit-Limit-Minute'), '10')
            self.assertEqual(response.headers.get('X-RateLimit-Limit-Second'), '3')

        # Native Redis accounting counts the burst-rejected attempt in the
        # minute window too. Six attempts remain after the initial four.
        # Sign-in, callback POSTs and server actions share them across peers.
        time.sleep(1.05)
        paths = ('/api/auth/signin/keycloak', '/api/auth/callback/keycloak',
                 '/login', '/api/auth/signin', '/api/auth/signin/keycloak/')
        with httpx.Client(timeout=10) as client:
            for index in range(6):
                peer = 'kong' if index % 2 else 'kong-peer'
                response = client.post(f'http://{peer}:8000{paths[index % len(paths)]}?callbackUrl=%2Fadmin',
                    headers={**spoofed, 'X-Forwarded-For': f'198.51.100.{index + 1}'},
                    data={'csrfToken': 'fixture', 'callbackUrl': '/admin'})
                self.assertEqual(response.status_code, 200, self.summary(response))
                self.assertEqual(response.headers.get('X-RateLimit-Limit-Minute'), '10')
                time.sleep(0.4)
            blocked = client.post('http://kong-peer:8000/api/auth/signin/keycloak?attempt=new',
                headers=spoofed, data={'csrfToken': 'fixture', 'callbackUrl': '/admin'})
            self.assertEqual(blocked.status_code, 429, self.summary(blocked))
            self.assertTrue(blocked.headers['Retry-After'].isdigit())
            self.assertFalse('"port":' in blocked.text, 'Throttled login reached upstream')
            for path in ('/api/auth/csrf', '/api/auth/providers', '/api/auth/callback/keycloak?code=fixture&state=fixture',
                         '/login', '/_next/static/fixture.js'):
                response = client.get('http://kong:8000' + path, headers=spoofed)
                self.assertEqual(response.status_code, 200, self.summary(response))
                self.assertEqual(response.headers.get('X-RateLimit-Limit-Minute'), '48')
            self.assertEqual(client.get('http://app:3000/__fixture/body-count').json()['contacts'], before + 9)

        connection = http.client.HTTPConnection('kong', 8000, timeout=5)
        try:
            connection.putrequest('POST', '/api/auth/signin/keycloak')
            connection.putheader('Content-Length', '100')
            connection.endheaders()
            # Send no body: the strict quota runs before buffering/auth work.
            response = connection.getresponse()
            self.assertEqual(response.status, 429)
            self.assertIsNotNone(response.getheader('Retry-After'))
            response.read()
        finally:
            connection.close()

    def test_z_anonymous_browser_and_oidc_ingress_is_shared_bounded_and_separate(self):
        # Anonymous quotas are intentionally exhausted last: all earlier
        # regression probes share this container's real socket-peer address.
        self.avoid_minute_boundary(margin=15)
        spoofed = {
            'Host': 'localhost:8006', 'InoutListener': '8006',
            'X-Forwarded-Port': '8006', 'X-Forwarded-For': '203.0.113.77',
            'X-Real-IP': '198.51.100.88', 'Forwarded': 'for=192.0.2.99;host=localhost:8006',
        }

        async def exhaust(port, remaining, paths, limit):
            async with httpx.AsyncClient(timeout=20) as client:
                async def request(index):
                    peer = 'kong' if index % 2 else 'kong-peer'
                    # A new forged identity or target listener on each call
                    # must not choose another bucket on either gateway.
                    headers = {**spoofed, 'X-Forwarded-For': f'203.0.113.{index % 250 + 1}',
                               'Host': f'localhost:{8002 if index % 2 else 8005}'}
                    return await client.get(f'http://{peer}:{port}{paths[index % len(paths)]}', headers=headers)
                responses = await asyncio.gather(*(request(index) for index in range(remaining + 4)))
            statuses = [response.status_code for response in responses]
            self.assertEqual(statuses.count(200), remaining, statuses)
            self.assertEqual(statuses.count(429), 4, statuses)
            for response in responses:
                self.assertEqual(response.headers.get('X-RateLimit-Limit-Minute'), str(limit))
                if response.status_code == 429:
                    self.assertGreaterEqual(int(response.headers['Retry-After']), 1)
                    self.assertLessEqual(int(response.headers['Retry-After']), 60)
                    self.assertFalse('"port":' in response.text, 'Anonymous throttled call reached upstream')

        with httpx.Client(timeout=10) as client:
            before = {
                8000: client.get('http://app:3000/__fixture/body-count').json()['contacts'],
                8005: client.get('http://keycloak:1105/__fixture/body-count').json()['contacts'],
            }
            browser = client.get('http://kong:8000/_next/static/fixture.js', headers=spoofed)
            identity = client.get('http://kong-peer:8005/realms/inout/.well-known/openid-configuration', headers=spoofed)
            api = client.get('http://kong:8002/limit', headers=self.auth(**spoofed))
            for response, port, limit in ((browser, 3000, 48), (identity, 1105, 64), (api, 1102, 8)):
                self.assertEqual(response.status_code, 200, self.summary(response))
                self.assertEqual(response.json()['port'], port)
                self.assertEqual(response.headers.get('X-RateLimit-Limit-Minute'), str(limit))

            asyncio.run(exhaust(8000, int(browser.headers['X-RateLimit-Remaining-Minute']),
                ('/', '/_next/static/fixture.js', '/api/auth/signin'), 48))
            independent_identity = client.get('http://kong:8005/resources/version/login/keycloak/style.css', headers=spoofed)
            self.assertEqual(independent_identity.status_code, 200, self.summary(independent_identity))
            self.assertEqual(int(independent_identity.headers['X-RateLimit-Remaining-Minute']),
                             int(identity.headers['X-RateLimit-Remaining-Minute']) - 1)
            self.assertEqual(client.get('http://kong-peer:8002/limit', headers=self.auth(**spoofed)).status_code, 200)

            asyncio.run(exhaust(8005, int(independent_identity.headers['X-RateLimit-Remaining-Minute']),
                ('/realms/inout/.well-known/openid-configuration',
                 '/realms/inout/protocol/openid-connect/auth',
                 '/resources/version/login/keycloak/style.css'), 64))
            maintenance = client.get('http://kong:8006/admin/realms/inout/users', headers=spoofed)
            self.assertEqual(maintenance.status_code, 200, self.summary(maintenance))
            self.assertIsNone(maintenance.headers.get('X-RateLimit-Limit-Minute'))
            api = client.get('http://kong:8002/limit', headers=self.auth(**spoofed))
            self.assertEqual(api.status_code, 200, self.summary(api))
            self.assertEqual(api.headers.get('X-RateLimit-Limit-Minute'), '8')
            for _ in range(int(api.headers['X-RateLimit-Remaining-Minute'])):
                self.assertEqual(client.get('http://kong:8002/limit', headers=self.auth(**spoofed)).status_code, 200)
            blocked_api = client.get('http://kong-peer:8002/limit', headers=self.auth(**spoofed))
            self.assertEqual(blocked_api.status_code, 429, self.summary(blocked_api))
            self.assertEqual(client.get('http://kong:8002/limit', headers=self.auth(uuid.uuid4().hex, **spoofed)).status_code, 200)

            for port, path in ((8000, '/v1/deadline-probe'), (8005, '/realms/inout/deadline-probe')):
                with self.subTest(port=port):
                    connection = http.client.HTTPConnection('kong', port, timeout=5)
                    try:
                        connection.putrequest('POST', path, skip_host=True)
                        for key, value in {**spoofed, 'Content-Length': '100'}.items():
                            connection.putheader(key, value)
                        connection.endheaders()
                        began = time.monotonic()
                        # Send no body. Ingress must reject before the native
                        # body reader's one-second fixture deadline starts.
                        response = connection.getresponse()
                        self.assertEqual(response.status, 429, 'Throttled upload was read before rejection')
                        self.assertLess(time.monotonic() - began, 0.9)
                        self.assertIsNotNone(response.getheader('Retry-After'))
                    finally:
                        connection.close()
            self.assertEqual(client.get('http://app:3000/__fixture/body-count').json()['contacts'], before[8000])
            self.assertEqual(client.get('http://keycloak:1105/__fixture/body-count').json()['contacts'], before[8005])

if __name__ == '__main__':
    unittest.main(verbosity=2)
