import argparse
import asyncio
import json
import os
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text
from facility_zones import CHECKPOINTS, normalize_facility_document, normalize_zones
from subject_metadata import current_subject_metadata

DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql+asyncpg://inout:inout@localhost:1003/inout"
)


async def seed_reference_data(engine) -> None:
    """Production-safe reference data required for the app to operate."""
    print("→ Seeding reference data...")
    async with engine.begin() as conn:
        for checkpoint in CHECKPOINTS:
            await conn.execute(text("""
                INSERT INTO checkpoints (id, data) VALUES (:id, CAST(:data AS jsonb))
                ON CONFLICT (id) DO UPDATE SET data = checkpoints.data || EXCLUDED.data
                """), {"id": checkpoint["id"], "data": json.dumps(checkpoint)})
        await conn.execute(
            text(
                """
                INSERT INTO alert_rules (id, data) VALUES
                  (:id1, CAST(:data1 AS jsonb)),
                  (:id2, CAST(:data2 AS jsonb))
                ON CONFLICT (id) DO NOTHING
                """
            ),
            {
                "id1": "rule-no-break",
                "data1": '{"id":"rule-no-break","name":"No break recorded","description":"Alert when an employee works six hours without a break.","category":"operational","severity":"medium","enabled":true,"scope":"Employee workdays","conditionKey":"no_break","recentTriggers":0}',
                "id2": "rule-irregularity",
                "data2": '{"id":"rule-irregularity","name":"Irregularity","description":"Alert when an active employee has no approved entry by the end of the day.","category":"presence_anomaly","severity":"medium","enabled":true,"scope":"Employee attendance","conditionKey":"irregularity","recentTriggers":0}',
            },
        )


async def seed_demo_data(engine) -> None:
    """Realistic local-development and demonstration data."""
    print("→ Seeding demo data...")
    await seed_reference_data(engine)

    async with engine.begin() as conn:
        await _seed_registered_subject(conn, subject_id="seed-demo-employee", kind="employee",
            barcode="DEMO-BARCODE-123", permission_id="seed-demo-permission",
            data={"name": "Demo Employee", "status": "active", "allowedZones": ["public", "secure"], "inside": False})


async def _seed_registered_subject(
    conn,
    *,
    subject_id: str,
    kind: str,
    barcode: str,
    data: dict,
    permission_id: str,
) -> str:
    """Insert one registry subject and its supporting rows without duplicates."""
    existing = (
        await conn.execute(
            text(
                "SELECT id, kind, barcode FROM subjects "
                "WHERE id = :id OR barcode = :barcode LIMIT 1"
            ),
            {"id": subject_id, "barcode": barcode},
        )
    ).mappings().first()

    if existing:
        if existing["kind"] != kind:
            raise RuntimeError(
                f"Cannot seed {barcode}: existing subject has kind {existing['kind']!r}"
            )
        actual_id = existing["id"]
        actual_barcode = existing["barcode"]
    else:
        await conn.execute(
            text(
                "INSERT INTO subjects (id, kind, barcode) "
                "VALUES (:id, :kind, :barcode)"
            ),
            {"id": subject_id, "kind": kind, "barcode": barcode},
        )
        actual_id = subject_id
        actual_barcode = barcode

    subject_data = {
        **current_subject_metadata(kind, normalize_facility_document(data, strict_zones=True)),
        "id": actual_id,
        "barcode": actual_barcode,
        "type": kind,
    }
    metadata_table = "people" if kind in {"employee", "visitor"} else "hardware_assets"
    await conn.execute(
        text(
            f"INSERT INTO {metadata_table} (subject_id, data) "
            "VALUES (:subject_id, CAST(:data AS jsonb)) "
            "ON CONFLICT (subject_id) DO NOTHING"
        ),
        {"subject_id": actual_id, "data": json.dumps(subject_data)},
    )
    await conn.execute(
        text(
            "INSERT INTO presence_state (subject_id, state) "
            "VALUES (:subject_id, 'outside') "
            "ON CONFLICT (subject_id) DO NOTHING"
        ),
        {"subject_id": actual_id},
    )
    await conn.execute(
        text(
            "INSERT INTO access_permissions (id, subject_id, data) "
            "SELECT :id, :subject_id, CAST(:data AS jsonb) "
            "WHERE NOT EXISTS ("
            "  SELECT 1 FROM access_permissions WHERE subject_id = :subject_id"
            ") ON CONFLICT (id) DO NOTHING"
        ),
        {
            "id": permission_id,
            "subject_id": actual_id,
            "data": json.dumps(
                {
                    "id": permission_id,
                    "subjectId": actual_id,
                    "subjectName": subject_data.get("name") or actual_barcode,
                    "subjectType": kind,
                    "assignment": kind.title(),
                    "state": "active",
                    "zones": normalize_zones(subject_data.get("allowedZones") or []),
                    "validFrom": subject_data.get("validFrom") or "",
                    "validTo": subject_data.get("validTo") or "",
                    "source": "seed",
                }
            ),
        },
    )
    return actual_id


async def seed_additional_data(engine) -> None:
    """Seed two employees and two active hardware assets for local use."""
    print("→ Seeding additional employees and hardware...")
    now = datetime.now(timezone.utc).isoformat()
    employees = [
        {
            "id": "seed-employee-001",
            "barcode": "SEED-EMP-001",
            "name": "Anika Rao",
            "phone": "+91 90000 00001",
        },
        {
            "id": "seed-employee-002",
            "barcode": "SEED-EMP-002",
            "name": "Vikram Shah",
            "phone": "+91 90000 00002",
        },
    ]

    async with engine.begin() as conn:
        employee_ids: list[str] = []
        for employee in employees:
            employee_ids.append(
                await _seed_registered_subject(
                    conn,
                    subject_id=employee["id"],
                    kind="employee",
                    barcode=employee["barcode"],
                    data={
                        "name": employee["name"],
                        "status": "active",
                        "phone": employee["phone"],
                        "allowedZones": ["public", "secure"],
                        "inside": False,
                        "validFrom": now,
                        "validTo": "",
                        "createdAt": now,
                    },
                    permission_id=f"seed-permission-employee-{employee['id'][-3:]}",
                )
            )

        hardware = [
            {
                "id": "seed-hardware-001",
                "barcode": "SEED-HW-001",
                "name": "Operations Laptop",
                "category": "Laptop",
                "owner": employees[0]["name"],
                "employee_id": employee_ids[0],
            },
            {
                "id": "seed-hardware-002",
                "barcode": "SEED-HW-002",
                "name": "Security Scanner",
                "category": "Scanner",
                "owner": employees[1]["name"],
                "employee_id": employee_ids[1],
            },
        ]
        for asset in hardware:
            await _seed_registered_subject(
                conn,
                subject_id=asset["id"],
                kind="hardware",
                barcode=asset["barcode"],
                data={
                    "name": asset["name"],
                    "category": asset["category"],
                    "owner": asset["owner"],
                    "assignedEmployeeId": asset["employee_id"],
                    "assignedEmployeeName": asset["owner"],
                    "status": "active",
                    "allowedZones": ["public", "secure"],
                    "inside": False,
                    "createdAt": now,
                },
                permission_id=f"seed-permission-hardware-{asset['id'][-3:]}",
            )

    print("✓ Seeded 2 employees and 2 hardware assets.")


async def seed_test_data(engine) -> None:
    """Deterministic small fixtures used exclusively by automated tests."""
    print("→ Seeding test data...")
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO subjects (id, kind, barcode) VALUES (:id, :kind, :barcode) "
                "ON CONFLICT (id) DO NOTHING"
            ),
            {"id": "test-subject-1", "kind": "employee", "barcode": "TEST-BARCODE-123"},
        )
        await conn.execute(
            text(
                "INSERT INTO presence_state (subject_id, state) VALUES (:sid, :state) "
                "ON CONFLICT (subject_id) DO NOTHING"
            ),
            {"sid": "test-subject-1", "state": "outside"},
        )
        await conn.execute(
            text(
                "INSERT INTO access_permissions (id, subject_id, data) VALUES (:id, :sid, :data) "
                "ON CONFLICT (id) DO NOTHING"
            ),
            {"id": "test-perm-1", "sid": "test-subject-1", "data": '{"zones": ["public"], "type": "permanent"}'},
        )


async def main() -> None:
    parser = argparse.ArgumentParser(description="Database Seeding Tool")
    parser.add_argument(
        "mode",
        choices=["reference", "demo", "additional", "test"],
        help="Seeding mode",
    )
    args = parser.parse_args()

    engine = create_async_engine(DATABASE_URL)

    try:
        if args.mode == "reference":
            await seed_reference_data(engine)
        elif args.mode == "demo":
            await seed_demo_data(engine)
        elif args.mode == "additional":
            await seed_additional_data(engine)
        elif args.mode == "test":
            await seed_test_data(engine)
        print(f"✓ Successfully seeded database in '{args.mode}' mode.")
    except Exception as e:
        print(f"✗ Error seeding database: {e}")
        raise
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
