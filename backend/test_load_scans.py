import asyncio
import httpx
import uuid
import time
import sys

async def hit_api_diff_key(client, barcode, session_id):
    headers = {
        'Idempotency-Key': str(uuid.uuid4()),
        'Content-Type': 'application/json'
    }
    payload = {
        'barcode': barcode,
        'terminal_id': 'dev-terminal',
        'checkpoint_id': session_id,
        'direction': 'entry'
    }
    start = time.perf_counter()
    response = await client.post('http://localhost:8000/v1/scans', json=payload, headers=headers)
    latency = time.perf_counter() - start
    return response.status_code, response.json(), latency

async def main():
    barcode = 'TEST-BARCODE-123' 
    session_id = str(uuid.uuid4())
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        # Check if server is up
        try:
            await client.get("http://localhost:8000/health/live")
        except httpx.ConnectError:
            print("Server is not running on port 8000!")
            sys.exit(1)
            
        tasks = [hit_api_diff_key(client, barcode, session_id) for _ in range(100)]
        results = await asyncio.gather(*tasks)
        
        latencies = [res[2] for res in results]
        latencies.sort()
        p95 = latencies[int(len(latencies) * 0.95)]
        
        successes = [res for res in results if res[0] == 200]
        cooldowns = [res for res in results if res[0] == 429]
        others = [res for res in results if res[0] not in (200, 429)]
        
        print(f"Total requests: {len(results)}")
        print(f"Successes (200): {len(successes)}")
        print(f"Cooldown hits (429): {len(cooldowns)}")
        print(f"Other status codes: {[res[0] for res in others]}")
        print(f"P95 Latency: {p95 * 1000:.2f}ms")
        
        # We need to consider both DIFFERENT keys and SAME keys.
        # Let's also do a SAME key test.
        idempotency_key = str(uuid.uuid4())
        async def hit_api_same_key(client, barcode, session_id):
            headers = {
                'Idempotency-Key': idempotency_key,
                'Content-Type': 'application/json'
            }
            payload = {
                'barcode': barcode,
                'terminal_id': 'dev-terminal',
                'checkpoint_id': session_id,
                'direction': 'exit' # using exit to avoid logical conflict since we just entered
            }
            start = time.perf_counter()
            response = await client.post('http://localhost:8000/v1/scans', json=payload, headers=headers)
            latency = time.perf_counter() - start
            return response.status_code, response.json(), latency

        tasks2 = [hit_api_same_key(client, barcode, session_id) for _ in range(100)]
        results2 = await asyncio.gather(*tasks2)
        successes2 = [res for res in results2 if res[0] == 200]
        others2 = [res for res in results2 if res[0] != 200]
        
        print(f"\\nIdempotency Test (Same Key):")
        print(f"Total requests: {len(results2)}")
        print(f"Successes (200): {len(successes2)}")
        print(f"Other status codes: {[res[0] for res in others2]}")
        
        if len(successes) != 1 or len(cooldowns) != 99:
            print("FAILED: Expected exactly 1 success and 99 cooldown hits for different keys.")
            sys.exit(1)
            
        if len(successes2) != 100:
            print("FAILED: Expected all 100 requests to succeed (via idempotency cache) for the same key.")
            sys.exit(1)
            
        if p95 >= 0.200:
            print("FAILED: P95 latency >= 200ms.")
            sys.exit(1)
            
        print("PASS")

if __name__ == "__main__":
    asyncio.run(main())
