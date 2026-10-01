import asyncio
import ssl
import time
import unittest
import httpx

class GatewayTests(unittest.TestCase):
    def test_listener_routing_headers_and_authentication(self):
        with httpx.Client(timeout=10) as client:
            for port, upstream in ((8000, 3000), (8002, 1102), (8005, 1105)):
                response = client.get(f'http://kong:{port}/example?eventId=EVT-000123', headers={
                    'Host': 'localhost:1008', 'Authorization': 'Bearer fixture-valid',
                    'Idempotency-Key': 'test-retry-key', 'X-Client-Verify': 'SUCCESS',
                    'X-Client-DN': 'CN=spoof', 'X-Proxy-Secret': 'spoof',
                    'X-Inout-Terminal-DN': 'CN=spoof', 'X-Inout-Gateway-Secret': 'spoof',
                    'InoutListener': '8443',
                    'X-Forwarded-Host': 'attacker.invalid', 'X-Forwarded-Proto': 'https'})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()['port'], upstream)
                self.assertEqual(response.json()['path'], '/example?eventId=EVT-000123')
                headers = response.json()['headers']
                self.assertEqual(headers['authorization'], 'Bearer fixture-valid')
                self.assertEqual(headers['idempotency-key'], 'test-retry-key')
                self.assertNotIn('attacker.invalid', headers.get('x-forwarded-host', ''))
                self.assertEqual(headers['x-forwarded-proto'], 'http')
                self.assertNotIn('inoutlistener', headers)
                for name in ('x-client-verify', 'x-client-dn', 'x-proxy-secret', 'x-inout-terminal-dn', 'x-inout-gateway-secret'):
                    self.assertNotIn(name, headers)
                self.assertIn('x-request-id', response.headers)
            self.assertEqual(client.get('http://kong:8002/v1/protected').status_code, 401)
            self.assertEqual(client.get('http://kong:8002/v1/protected', headers={'Authorization':'Bearer fixture-valid'}).status_code, 200)
            with self.assertRaises(httpx.ConnectError):
                client.get('http://kong:8001/')

    def test_http_cannot_spoof_terminal_identity(self):
        for port in (8000, 8002, 8005):
            response = httpx.post(f'http://kong:{port}/v1/scans', headers={
                'X-Client-Verify':'SUCCESS', 'X-Client-DN':'CN=terminal-test',
                'X-Inout-Terminal-DN':'CN=terminal-test',
                'X-Inout-Gateway-Secret':'gateway-test-secret-not-for-production-12345'})
            self.assertEqual(response.status_code, 401)

    def test_mtls_accepts_only_trusted_current_certificates(self):
        for certificate in (None, 'untrusted', 'expired', 'client'):
            context = ssl.create_default_context(cafile='/certificates/ca.crt')
            if certificate:
                context.load_cert_chain(f'/certificates/{certificate}.crt', f'/certificates/{certificate}.key')
            with httpx.Client(verify=context, timeout=10) as client:
                response = client.post('https://kong:8443/v1/scans', headers={'X-Inout-Terminal-DN':'CN=spoof'})
                if certificate == 'client':
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.json()['headers']['x-inout-terminal-dn'], 'CN=terminal-test')
                    self.assertEqual(response.json()['headers']['x-inout-gateway-secret'], 'gateway-test-secret-not-for-production-12345')
                    self.assertEqual(client.get('https://kong:8443/admin').status_code, 404)
                else:
                    self.assertGreaterEqual(response.status_code, 400)

    def test_api_body_limit_including_chunked_requests(self):
        for body in (b'x' * 262145, iter([b'x' * 131073, b'x' * 131073])):
            response = httpx.post('http://kong:8002/v1/example', content=body)
            self.assertEqual(response.status_code, 413, response.text)

    def test_events_are_not_buffered(self):
        for port, path in ((8000, '/api/presence'), (8002, '/v1/presence/stream')):
            with httpx.stream('GET', f'http://kong:{port}{path}', timeout=10) as response:
                # Measure delivery after headers; cold Docker DNS is unrelated to buffering.
                started = time.monotonic()
                self.assertEqual(response.status_code, 200)
                lines = response.iter_lines()
                self.assertEqual(next(lines), ': heartbeat')
                self.assertLess(time.monotonic() - started, 2)
                self.assertEqual(next(lines), '')
                self.assertEqual(next(lines), 'data: {"state":"inside"}')
                self.assertGreater(time.monotonic() - started, 2)

    def test_rate_limit_returns_429(self):
        # The plugin uses wall-clock minute buckets. A burst straddling the
        # boundary can legitimately fit in two budgets, so start in a fresh one.
        time.sleep(60 - time.time() % 60 + 0.1)
        async def burst():
            semaphore = asyncio.Semaphore(20)
            async with httpx.AsyncClient(timeout=20) as client:
                async def request():
                    async with semaphore:
                        return (await client.get('http://kong:8002/limit')).status_code
                return await asyncio.gather(*(request() for _ in range(1201)))
        self.assertTrue(429 in asyncio.run(burst()), "The single-minute burst must exceed the configured API budget")

if __name__ == '__main__':
    unittest.main(verbosity=2)
