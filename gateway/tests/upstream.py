"""Small independent upstreams expose routing/header/stream behavior for tests."""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
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
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        if length:
            self.rfile.read(length)
        self.do_GET()

for port in (3000, 1102, 1105):
    threading.Thread(target=ThreadingHTTPServer(('0.0.0.0', port), Handler).serve_forever, daemon=True).start()
threading.Event().wait()
