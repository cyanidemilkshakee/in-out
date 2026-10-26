import logging
from contextlib import asynccontextmanager

from fastapi import Request
from sqlalchemy.exc import TimeoutError as PoolTimeoutError
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase

from config import settings

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    """SQLAlchemy 2.0-style base class for all ORM models."""
    pass


def database_engine_options(configuration=settings):
    """Bound connection, checkout, server execution and transport waits."""
    return {
        "echo": False,
        "hide_parameters": True,
        "pool_size": 5,
        "max_overflow": 10,
        "pool_timeout": configuration.DATABASE_POOL_TIMEOUT_SECONDS,
        "pool_pre_ping": True,
        "connect_args": {
            # Direct Compose connections preserve prepared statements. A
            # transaction pool can opt out with the existing cache setting.
            "prepared_statement_cache_size": configuration.DATABASE_STATEMENT_CACHE_SIZE,
            "statement_cache_size": configuration.DATABASE_STATEMENT_CACHE_SIZE,
            "timeout": configuration.DATABASE_CONNECT_TIMEOUT_SECONDS,
            # The server should cancel first; the transport bound also covers
            # a broken network that never delivers its cancellation response.
            "command_timeout": configuration.DATABASE_STATEMENT_TIMEOUT_MS / 1000 + 5,
            "server_settings": {
                "statement_timeout": str(configuration.DATABASE_STATEMENT_TIMEOUT_MS),
                "lock_timeout": str(configuration.DATABASE_LOCK_TIMEOUT_MS),
            },
        },
    }


def is_database_timeout(error):
    """Classify timeout failures without inspecting SQL, parameters or messages."""
    pending, visited = [error], set()
    while pending and len(visited) < 16:
        current = pending.pop()
        if current is None or id(current) in visited:
            continue
        visited.add(id(current))
        if isinstance(current, (TimeoutError, PoolTimeoutError)):
            return True
        if getattr(current, "sqlstate", None) in {"57014", "55P03"}:
            return True
        pending.extend((getattr(current, "orig", None), getattr(current, "__cause__", None)))
    return False


# Both engines have identical safety bounds, including when reads use a replica.
engine = create_async_engine(settings.DATABASE_URL, **database_engine_options())

# --- Read engine (a replica when READ_DATABASE_URL is configured) ---
read_engine = create_async_engine(settings.READ_DATABASE_URL, **database_engine_options())

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

async_session = AsyncSessionLocal


@asynccontextmanager
async def _session_dependency(sessions):
    async with sessions() as session:
        try:
            yield session
        except BaseException:
            await rollback_after_error(session)
            raise


async def rollback_after_error(session):
    """Release failed transactions without hiding the initiating exception."""
    try:
        await session.rollback()
    except Exception as rollback_error:
        logger.warning("Database rollback failed", extra={"exception_type": type(rollback_error).__name__})
        try:
            await session.invalidate()
        except Exception as invalidation_error:
            logger.warning("Database connection invalidation failed",
                extra={"exception_type": type(invalidation_error).__name__})


async def get_db(request: Request = None):
    async with _session_dependency(AsyncSessionLocal) as session:
        if request is not None:
            # The route builds its JSON response before its transaction commit.
            # Keep the verified request identity available to that precommit
            # response quota check.
            session.info["request_scope"] = request.scope
        yield session


async def get_read_db():
    async with _session_dependency(AsyncReadSessionLocal) as session:
        yield session
