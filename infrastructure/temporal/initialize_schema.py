"""Initialize a fresh Temporal 1.32 cluster; reject unstaged existing clusters.

Only the scoped inout_temporal role is accepted. The marker records the origin
of a fresh cluster, independently of schema versions, so merely applying new
schemas to an old 1.26 cluster cannot authorize a multi-minor server jump.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import subprocess
import sys

import asyncpg

SERVER_MINOR = "1.32"
VERSIONS = {"temporal": "1.19", "temporal_visibility": "1.14"}
MARKER = "inout_temporal_bootstrap"
LOCK_KEY = 732132001


class InitializationRejected(RuntimeError):
    pass


def connection_options():
    if os.environ.get("SQL_USER", "inout_temporal") != "inout_temporal":
        raise InitializationRejected("Only the scoped inout_temporal database role is supported")
    password = os.environ.get("SQL_PASSWORD") or os.environ.get("TEMPORAL_DB_PASSWORD")
    if not password:
        raise InitializationRejected("SQL_PASSWORD or TEMPORAL_DB_PASSWORD is required")
    return dict(host=os.environ.get("SQL_HOST", "postgres-primary"),
                port=int(os.environ.get("SQL_PORT", "5432")), user="inout_temporal",
                password=password, timeout=10, command_timeout=30)


async def inspect(connection, database):
    safe = await connection.fetchval("""SELECT NOT rolsuper AND NOT rolcreatedb
        AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
        FROM pg_roles WHERE rolname=current_user""")
    owner = await connection.fetchval("""SELECT pg_get_userbyid(datdba)=current_user
        FROM pg_database WHERE datname=current_database()""")
    if safe is not True or owner is not True:
        raise InitializationRejected("Temporal initialization requires a scoped database owner without administrative privileges")
    tables = await connection.fetch("""SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass
            AND d.objid=c.oid AND d.deptype='e')""")
    names = {row[0] for row in tables}
    if not names:
        return "fresh"
    if MARKER not in names:
        raise InitializationRejected("Existing Temporal data has no staged-upgrade/origin marker; automatic multi-minor upgrade refused")
    rows = await connection.fetch(f"SELECT origin_minor,status FROM public.{MARKER}")
    if len(rows) != 1 or rows[0]["origin_minor"] != SERVER_MINOR or rows[0]["status"] not in ("initializing", "ready"):
        raise InitializationRejected("Temporal origin marker does not authorize this server version")
    if rows[0]["status"] == "ready":
        await verify_version(connection, database)
        return "ready"
    return "initializing"


async def verify_version(connection, database):
    if not await connection.fetchval("SELECT to_regclass('public.schema_version') IS NOT NULL"):
        raise InitializationRejected("Temporal schema metadata is missing")
    rows = await connection.fetch("SELECT curr_version FROM public.schema_version")
    if len(rows) != 1 or rows[0]["curr_version"] != VERSIONS[database]:
        raise InitializationRejected("Temporal schema version does not match the pinned server release")


async def run_tool(database, command, *arguments):
    environment = os.environ.copy()
    options = connection_options()
    environment.update(SQL_HOST=options["host"], SQL_PORT=str(options["port"]),
                       SQL_USER=options["user"], SQL_PASSWORD=options["password"],
                       SQL_PLUGIN="postgres12")
    # Password stays in the environment, never command arguments or diagnostics.
    result = await asyncio.to_thread(subprocess.run,
        ["temporal-sql-tool", "--db", database, command, *arguments],
        env=environment, capture_output=True, timeout=120)
    if result.returncode:
        raise InitializationRejected(f"Official Temporal SQL tool failed for {database}; initialization remains incomplete")


async def fixture_self_test(connections):
    if os.environ.get("INOUT_TEMPORAL_FIXTURE") != "1":
        raise InitializationRejected("Synthetic guard tests require the isolated fixture flag")
    connection = connections["temporal"]
    for advanced in (False, True):
        try:
            async with connection.transaction():
                if await connection.fetchval(f"SELECT to_regclass('public.{MARKER}') IS NOT NULL"):
                    await connection.execute(f"DROP TABLE public.{MARKER}")
                await connection.execute("CREATE TABLE public.legacy_fixture (id integer)")
                if advanced and not await connection.fetchval("SELECT to_regclass('public.schema_version') IS NOT NULL"):
                    await connection.execute("CREATE TABLE public.schema_version (curr_version text)")
                    await connection.execute("INSERT INTO public.schema_version VALUES ($1)", VERSIONS["temporal"])
                try:
                    await inspect(connection, "temporal")
                except InitializationRejected:
                    kind = "advanced-schema" if advanced else "existing"
                    print(f"PASS: unmarked {kind} Temporal data rejected without schema-tool execution")
                else:
                    raise AssertionError("An unmarked existing cluster was accepted")
                # Roll back every synthetic object/marker removal, even on ready DBs.
                raise FixtureRollback()
        except FixtureRollback:
            pass


class FixtureRollback(Exception):
    pass


async def initialize(args):
    connections = {}
    try:
        for database in VERSIONS:
            connection = await asyncpg.connect(database=database, **connection_options())
            connections[database] = connection
            if not await connection.fetchval("SELECT pg_try_advisory_lock($1)", LOCK_KEY):
                raise InitializationRejected("Another Temporal initializer is active")
        if args.fixture_self_test:
            await fixture_self_test(connections)
            return
        if args.fixture_resume:
            if os.environ.get("INOUT_TEMPORAL_FIXTURE") != "1":
                raise InitializationRejected("Synthetic interruption requires the isolated fixture flag")
            for database, connection in connections.items():
                if await inspect(connection, database) != "ready":
                    raise InitializationRejected("Interruption fixture requires fully initialized synthetic schemas")
            for connection in connections.values():
                await connection.execute(f"UPDATE public.{MARKER} SET status='initializing'")
            print("Fixture: simulate interruption after schema updates, before marking ready")
        states = {database: await inspect(connection, database)
                  for database, connection in connections.items()}
        if args.verify_only:
            if any(state != "ready" for state in states.values()):
                raise InitializationRejected("Temporal schemas have not completed initialization")
            print("Temporal 1.32 origin markers and schemas verified (persistence 1.19; visibility 1.14)")
            return
        # Inspect BOTH databases before writing either marker or running a tool.
        for database, connection in connections.items():
            if states[database] == "fresh":
                async with connection.transaction():
                    await connection.execute(f"""CREATE TABLE public.{MARKER} (
                        singleton boolean PRIMARY KEY CHECK(singleton),
                        origin_minor text NOT NULL, status text NOT NULL)
                    """)
                    await connection.execute(f"INSERT INTO public.{MARKER} VALUES (true,$1,'initializing')", SERVER_MINOR)
        for database, connection in connections.items():
            if states[database] == "ready":
                continue
            if not await connection.fetchval("SELECT to_regclass('public.schema_version') IS NOT NULL"):
                await run_tool(database, "setup-schema", "--version", "0.0")
            name = "temporal" if database == "temporal" else "visibility"
            await run_tool(database, "update-schema", "--schema-name", f"postgresql/v12/{name}",
                           "--version", VERSIONS[database])
            await verify_version(connection, database)
        for connection in connections.values():
            await connection.execute(f"UPDATE public.{MARKER} SET status='ready'")
        print("Temporal 1.32 fresh-origin schemas ready (persistence 1.19; visibility 1.14)")
    finally:
        for connection in connections.values():
            await connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--fixture-self-test", action="store_true")
    parser.add_argument("--fixture-resume", action="store_true")
    args = parser.parse_args()
    try:
        asyncio.run(initialize(args))
    except InitializationRejected as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
    except Exception as error:
        print(f"Temporal initialization failed ({type(error).__name__}); credentials were not logged", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
