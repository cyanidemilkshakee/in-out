import argparse
import asyncio
import os
import uuid

from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text

DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql+asyncpg://inout:inout@localhost:1003/inout"
)


async def seed_reference_data(engine) -> None:
    """Production-safe reference data required for the app to operate."""
    print("→ Seeding reference data...")
    async with engine.begin() as conn:
        await conn.execute(
            text(
                """
                INSERT INTO checkpoints (id, data) VALUES
                  (:id1, :data1),
                  (:id2, :data2)
                ON CONFLICT (id) DO NOTHING
                """
            ),
            [
                {"id1": "main-gate",   "data1": '{"name": "Main Entrance", "zone": "public"}',
                 "id2": "server-room", "data2": '{"name": "Server Room",   "zone": "secure"}'},
            ],
        )
        await conn.execute(
            text(
                """
                INSERT INTO alert_rules (id, data) VALUES
                  (:id1, CAST(:data1 AS jsonb)),
                  (:id2, CAST(:data2 AS jsonb)),
                  (:id3, CAST(:data3 AS jsonb)),
                  (:id4, CAST(:data4 AS jsonb))
                ON CONFLICT (id) DO NOTHING
                """
            ),
            {
                "id1": "rule-restricted-entry",
                "data1": '{"id":"rule-restricted-entry","name":"Restricted employee entry","description":"Alert when a restricted employee attempts access.","category":"access_violation","severity":"high","enabled":true,"scope":"All checkpoints","conditionKey":"restricted_employee_entry","recentTriggers":0}',
                "id2": "rule-unauthorized-hardware",
                "data2": '{"id":"rule-unauthorized-hardware","name":"Unauthorized hardware carrier","description":"Alert when an item is carried by the wrong person.","category":"hardware_custody","severity":"high","enabled":true,"scope":"All checkpoints","conditionKey":"unauthorized_hardware_carrier","recentTriggers":0}',
                "id3": "rule-exit-balance",
                "data3": '{"id":"rule-exit-balance","name":"Exit balance anomaly","description":"Alert when approved exits exceed approved entries.","category":"presence_anomaly","severity":"medium","enabled":true,"scope":"Daily facility totals","conditionKey":"exit_balance","recentTriggers":0}',
                "id4": "rule-no-break",
                "data4": '{"id":"rule-no-break","name":"No break recorded","description":"Alert when an employee works six hours without a break.","category":"operational","severity":"medium","enabled":true,"scope":"Employee workdays","conditionKey":"no_break","recentTriggers":0}',
            },
        )


async def seed_demo_data(engine) -> None:
    """Realistic local-development and demonstration data."""
    print("→ Seeding demo data...")
    await seed_reference_data(engine)

    subject_id = str(uuid.uuid4())
    perm_id = str(uuid.uuid4())

    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO subjects (id, kind, barcode) VALUES (:id, :kind, :barcode) "
                "ON CONFLICT (id) DO NOTHING"
            ),
            {"id": subject_id, "kind": "employee", "barcode": "DEMO-BARCODE-123"},
        )
        await conn.execute(
            text(
                "INSERT INTO people (subject_id, data) VALUES (:sid, :data) "
                "ON CONFLICT (subject_id) DO NOTHING"
            ),
            {
                "sid": subject_id,
                "data": '{"name":"Demo Employee","status":"active",'
                         '"allowedZones":["public","secure"],"inside":false}',
            },
        )
        await conn.execute(
            text(
                "INSERT INTO presence_state (subject_id, state) VALUES (:sid, :state) "
                "ON CONFLICT (subject_id) DO NOTHING"
            ),
            {"sid": subject_id, "state": "outside"},
        )
        await conn.execute(
            text(
                "INSERT INTO access_permissions (id, subject_id, data) VALUES (:id, :sid, :data)"
            ),
            {"id": perm_id, "sid": subject_id, "data": '{"zones": ["public", "secure"], "type": "permanent"}'},
        )


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
    parser.add_argument("mode", choices=["reference", "demo", "test"], help="Seeding mode")
    args = parser.parse_args()

    engine = create_async_engine(DATABASE_URL)

    try:
        if args.mode == "reference":
            await seed_reference_data(engine)
        elif args.mode == "demo":
            await seed_demo_data(engine)
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
