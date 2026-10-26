"""Repeatable synthetic handler benchmark; requires a disposable *_test database.

No operational services, identity provider, or real subject records are used.
The baseline is the retained complete-read contract, not a different git tree.
"""
import argparse
import asyncio
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import statistics
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent / "tests"))
import test_database as fixture
from sqlalchemy import event
from models import Alert, Movement, Person, Subject
from routers import alerts, dashboard, registry
from routers.exports import ExportQuery, _existing_read, build_export
from event_outbox import dispatch_one, enqueue_presence
from schemas import BrowserScanPayload
from terminal_scans import record_scan


def percentile(values, percentage):
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, int((len(ordered) - 1) * percentage))], 3) if values else None


async def benchmark(args):
    if not fixture.TEST_URL:
        raise RuntimeError("TEST_DATABASE_URL must point to a dedicated database ending in _test")
    case = fixture.DatabaseTests("test_unauthenticated_reads_and_writes_are_rejected")
    await case.asyncSetUp()
    observation = ContextVar("benchmark_observation", default=None)

    def observe(_conn, _cursor, statement, _parameters, _context, _many):
        current = observation.get()
        if current is not None:
            current["sql"] += 1
            lowered = statement.lower()
            if lowered.startswith("insert into presence_state") or ("from presence_state" in lowered and "for update" in lowered):
                current["presenceSql"] += 1

    event.listen(case.engine.sync_engine, "before_cursor_execute", observe)
    report = {"scope": "Synthetic PostgreSQL handler timings; excludes HTTP, TLS, Kong, Keycloak and rendering",
        "baseline": "Retained complete read and public 200-row pagination contracts on the same seeded database",
        "fixture": vars(args), "results": {}}
    try:
        now = datetime.now(timezone.utc)
        async with case.sessions() as db:
            db.add_all([Subject(id=f"bench-person-{index}", kind="employee", barcode=f"BENCH-{index}",
                person=Person(data={"name": f"Employee {index:05}", "status": "active", "allowedZones": ["a"], "inside": False}))
                for index in range(args.subjects)])
            await db.flush()
            db.add_all([Movement(id=f"bench-movement-{index}", subject_id=f"bench-person-{index % args.subjects}",
                checkpoint_id="a-1", occurred_at=now - timedelta(seconds=(args.movements - index) * 12),
                result="approved", direction="entry" if (index // args.subjects) % 2 == 0 else "exit",
                scan_type="auto", subject_type="employee", sync_state="synced",
                data={"subjectName": f"Employee {index % args.subjects:05}", "barcode": f"BENCH-{index % args.subjects}", "checkpoint": "Front Gate"})
                for index in range(args.movements)])
            db.add_all([Alert(id=f"bench-alert-{index}", created_at=now - timedelta(minutes=index), data={
                "id": f"bench-alert-{index}", "title": "Attendance irregularity", "ruleId": "rule-attendance-irregularity",
                "subjectId": f"bench-person-{index % args.subjects}", "subjectName": f"Employee {index % args.subjects:05}",
                "subjectType": "employee", "barcode": f"BENCH-{index % args.subjects}", "status": "open", "severity": "medium"})
                for index in range(args.alerts)])
            await db.commit()

        async def timed(name, operation, samples=None, concurrency=1):
            durations, sizes, sql, presence, errors = [], [], [], [], []
            semaphore = asyncio.Semaphore(concurrency)

            async def once(index):
                async with semaphore:
                    counts = {"sql": 0, "presenceSql": 0}
                    token = observation.set(counts)
                    started = time.perf_counter()
                    try:
                        result = await operation(index)
                        sizes.append(len(json.dumps(result, default=str, separators=(",", ":")).encode()))
                        durations.append((time.perf_counter() - started) * 1000)
                        sql.append(counts["sql"])
                        presence.append(counts["presenceSql"])
                    except Exception as error:
                        errors.append(type(error).__name__ + ": " + str(error))
                    finally:
                        observation.reset(token)
            await asyncio.gather(*(once(index) for index in range(samples or args.samples)))
            report["results"][name] = {"samples": len(durations), "concurrency": concurrency,
                "p50Ms": percentile(durations, .5), "p95Ms": percentile(durations, .95), "p99Ms": percentile(durations, .99),
                "medianSql": statistics.median(sql) if sql else None, "medianPresenceSql": statistics.median(presence) if presence else None,
                "medianResponseBytes": statistics.median(sizes) if sizes else None, "errors": errors}

        async def read(endpoint, **kwargs):
            async with case.sessions() as db:
                return await _existing_read(endpoint, db, **kwargs)

        # Warm connections/prepared statements; warmed cases are still measured
        # on the same fixture and resource budget.
        await read(registry.registry_bundle)
        await read(registry.registry_bundle, kind="employee", days=1, limit=25)
        await timed("registryComplete", lambda _: read(registry.registry_bundle))
        await timed("registryFirst25WithGlobalSummary", lambda _: read(registry.registry_bundle, kind="employee", days=1, limit=25))
        await timed("alertsComplete", lambda _: read(alerts.list_alerts, limit=min(args.alerts, 500)))
        await timed("alertsCommandFirst50", lambda _: read(alerts.list_alerts, view="command", limit=50))

        async def paged_report(_index):
            from routers.movements import list_movements
            async with case.sessions() as db:
                first = await _existing_read(list_movements, db, limit=200, page_size=200, subjectGroup="people")
                items = first["items"]
                for offset in range(200, first["total"], 200):
                    page = await _existing_read(list_movements, db, limit=200, page_size=200, offset=offset, subjectGroup="people")
                    items += page["items"]
                return {"items": items, "total": first["total"]}

        async def single_report(_index):
            async with case.sessions() as db:
                return await build_export(db, ExportQuery(source="movements", subjectGroup="people"))
        await timed("reportPublic200RowPages", paged_report, samples=min(args.samples, 5))
        await timed("reportOneConsistentRead", single_report, samples=min(args.samples, 5))
        report["reportBrowserRequests"] = {"before": (args.movements + 199) // 200, "after": 1}

        async def scan(index):
            async with case.sessions() as db:
                result = await record_scan(db, uuid.uuid4(), BrowserScanPayload(barcode=f"BENCH-{index}", checkpointId="a-1"), "benchmark")
                if not result["allowed"]:
                    raise RuntimeError("Synthetic scan was denied: " + str(result["decision"]))
                await enqueue_presence(db, {"type": "scan", "movement": result["decision"]["event"]})
                await db.commit()
                return result
        await timed("scanWithDurableIntent", scan, concurrency=args.concurrency)
        if args.subjects >= args.samples * 2:
            await timed("mixedScansAndDashboard", lambda index: scan(index + args.samples)
                if index % 2 == 0 else read(dashboard.get_dashboard), concurrency=args.concurrency)
        # Count scan baseline statements from the old per-subject insert/lock
        # algorithm; latency is deliberately not fabricated for deleted code.
        report["presenceStatements"] = {"baselineFormula": "2 * (1 + carriedAssets)", "current": 2,
                                        "withThreeAssetsBefore": 8, "withThreeAssetsAfter": 2}

        async def drain(_kind, _payload):
            return None
        delivered = 0
        started = time.perf_counter()
        while await dispatch_one(sessions=case.sessions, deliver=drain):
            delivered += 1
        report["syntheticDelivery"] = {"rows": delivered, "drainMs": round((time.perf_counter() - started) * 1000, 3),
            "transport": "injected successful no-network sink; not Redis/Temporal latency"}
        await timed("dashboardWithAggregateReads", lambda _: read(dashboard.get_dashboard), concurrency=args.concurrency)
        return report
    finally:
        event.remove(case.engine.sync_engine, "before_cursor_execute", observe)
        await case.asyncTearDown()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--subjects", type=int, default=1000)
    parser.add_argument("--movements", type=int, default=5000)
    parser.add_argument("--alerts", type=int, default=500)
    parser.add_argument("--samples", type=int, default=12)
    parser.add_argument("--concurrency", type=int, default=4)
    arguments = parser.parse_args()
    if not (1 <= arguments.samples <= min(arguments.subjects, 100) and 1 <= arguments.concurrency <= 8
            and 1 <= arguments.subjects <= 5000 and 0 <= arguments.movements <= 10_000 and 1 <= arguments.alerts <= 500):
        parser.error("Choose bounded fixture sizes and samples no larger than the subject count")
    print(json.dumps(asyncio.run(benchmark(arguments)), indent=2))
