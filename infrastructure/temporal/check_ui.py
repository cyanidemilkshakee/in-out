"""Read-only private-network UI startup and Temporal proxy check."""
import json
import time
import urllib.error
import urllib.request

deadline = time.monotonic() + 45
while True:
    try:
        with urllib.request.urlopen("http://temporal-ui:8080/", timeout=3) as response:
            assert response.status == 200
            assert b"<html" in response.read(524288).lower()
        with urllib.request.urlopen("http://temporal-ui:8080/api/v1/namespaces", timeout=3) as response:
            assert response.status == 200
            data = json.loads(response.read(524288))
            assert any(item.get("namespaceInfo", {}).get("name") == "default"
                       for item in data.get("namespaces", []))
        print("PASS: UI 2.55.0 serves its frontend and proxies the default namespace from server 1.32.1")
        break
    except (urllib.error.URLError, TimeoutError):
        if time.monotonic() >= deadline:
            raise RuntimeError("Isolated Temporal UI did not become ready before deadline") from None
        time.sleep(1)
