import asyncio
import os
from logging.config import fileConfig

from sqlalchemy.ext.asyncio import async_engine_from_config
from sqlalchemy import pool

from alembic import context

# Alembic Config object — provides access to alembic.ini values.
config = context.config

# Set up logging from alembic.ini
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# --- Inject DATABASE_URL from environment so we never store credentials in alembic.ini ---
# Alembic requires a sync-compatible URL for offline mode, but we convert it
# to the asyncpg dialect for the online async runner below.
_db_url = os.getenv("DATABASE_URL", "postgresql+asyncpg://inout:inout@localhost:1003/inout")
# Ensure the URL uses the async driver for the engine, but sync for offline mode
_sync_url = _db_url.replace("postgresql+asyncpg://", "postgresql://")
config.set_main_option("sqlalchemy.url", _db_url)

target_metadata = None


def run_migrations_offline() -> None:
    """Offline mode: emit SQL to stdout without a live DB connection."""
    context.configure(
        url=_sync_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection):
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    """Online mode: use an async engine so asyncpg is supported."""
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


def run_migrations_online() -> None:
    """Entry point for online migrations — drives the async runner."""
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
