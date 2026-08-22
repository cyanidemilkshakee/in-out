import argparse
import asyncio
import os
import uuid

from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text

DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql+asyncpg://inout:inout@localhost:6432/inout"
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
