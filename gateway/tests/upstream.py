"""Small independent upstreams expose routing/header/stream behavior for tests."""
import json
import os
import re
import secrets
import threading
import time
body_contacts = {}
identity_states = {}
identity_lock = threading.Lock()
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class FixtureServer(ThreadingHTTPServer):
    # Concurrent replica tests should exercise Kong's quota, rather than the
    # standard library server's default five-connection SYN backlog.
    request_queue_size = 128

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def identity(self):
        expected = os.environ['INOUT_GATEWAY_IDENTITY_SECRET']
        supplied = self.headers.get('X-Inout-Gateway-Secret', '')
        authorization = self.headers.get('Authorization', '')
        match = re.fullmatch(r'Bearer fixture-account-([A-Za-z0-9_-]+)-token-([0-9]+)', authorization)
        account = match[1] if match else 'valid' if authorization == 'Bearer fixture-valid' else None
        status = 403 if not secrets.compare_digest(expected, supplied) else 401 if account is None else 200
        with identity_lock:
            state = dict(identity_states.get(account, {}))
        if status == 200:
            status = state.get('status', 200)
        document = {'identity': 'principal:fixture-issuer:' + account,
                    'expires_at': state.get('expires_at', time.time() + 300)} if status == 200 else {'detail': 'Fixture identity rejected'}
        body = json.dumps(document).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/__fixture/body-count':
            body = json.dumps({'contacts': body_contacts.get(self.server.server_port, 0)}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.split('?')[0] in ('/api/presence', '/v1/presence/stream'):
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            self.wfile.write(b': heartbeat\n\n')
            self.wfile.flush()
            time.sleep(3)
            self.wfile.write(b'data: {"state":"inside"}\n\n')
            self.wfile.flush()
            return
        status = 401 if self.path == '/v1/protected' and self.headers.get('Authorization') != 'Bearer fixture-valid' else 200
        body = json.dumps({'port': self.server.server_port, 'path': self.path,
            'headers': {key.lower(): value for key, value in self.headers.items()}}).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        if self.path.split('?')[0] == '/api/auth/fixture-session':
            # Auth.js splits a large encrypted session into browser-sized
            # cookies. Their combined response headers exceed 16 KiB even
            # though every individual cookie stays below the 4 KiB limit.
            for index in range(6):
                self.send_header('Set-Cookie',
                    f'authjs.session-token.{index}=' + str(index) * 3500
                    + '; Path=/; HttpOnly; SameSite=Lax')
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path == '/__fixture/identity-state':
            # This control exists only on the disposable synthetic upstream.
            # Tests call its internal socket directly, never a deployed API.
            length = int(self.headers.get('Content-Length', 0))
            data = self.rfile.read(length)
            if not secrets.compare_digest(os.environ['INOUT_GATEWAY_IDENTITY_SECRET'],
                                          self.headers.get('X-Inout-Gateway-Secret', '')):
                self.send_error(403)
                return
            state = json.loads(data)
            with identity_lock:
                identity_states[state.pop('account')] = state
            self.send_response(204)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if self.path == '/internal/gateway/identity':
            length = int(self.headers.get('Content-Length', 0))
            if length:
                self.rfile.read(length)
            self.identity()
            return
        body_contacts[self.server.server_port] = body_contacts.get(self.server.server_port, 0) + 1
        length = int(self.headers.get('Content-Length', 0))
        if length:
            self.rfile.read(length)
        self.do_GET()

    do_PUT = do_POST
    do_PATCH = do_POST
    do_DELETE = do_POST

for port in (3000, 1102, 1105):
    threading.Thread(target=FixtureServer(('0.0.0.0', port), Handler).serve_forever, daemon=True).start()
threading.Event().wait()
