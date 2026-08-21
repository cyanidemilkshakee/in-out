from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase

from config import settings


class Base(DeclarativeBase):
    """SQLAlchemy 2.0-style base class for all ORM models."""
    pass


# --- Write engine (routes through PgBouncer on port 6432) ---
# IMPORTANT: prepared_statement_cache_size=0 is required when PgBouncer runs in
# transaction pooling mode. asyncpg uses server-side prepared statements by
# default; transaction mode returns the connection to the pool before the
# session is torn down, so the next consumer sees stale/missing statement names.
engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,
    pool_size=5,
    max_overflow=10,
    pool_timeout=30,
    # Validate connections before checkout — prevents errors after PgBouncer/Postgres restart.
    pool_pre_ping=True,
    connect_args={
        "prepared_statement_cache_size": 0,
        "statement_cache_size": 0,
    },
)

# --- Read engine (routes to Postgres replica for analytics / dashboard queries) ---
read_engine = create_async_engine(
    settings.READ_DATABASE_URL,
    echo=False,
    pool_size=5,
    max_overflow=10,
    pool_timeout=30,
    pool_pre_ping=True,
    connect_args={
        "prepared_statement_cache_size": 0,
        "statement_cache_size": 0,
    },
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False,
)

AsyncReadSessionLocal = async_sessionmaker(
    bind=read_engine,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False,
)


async def get_db():
    async with AsyncSessionLocal() as session:
        yield session


async def get_read_db():
    async with AsyncReadSessionLocal() as session:
        yield session
