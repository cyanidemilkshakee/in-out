"""Provision/rotate scoped DB roles without logging credentials.

The normal bootstrap permits only an empty database or a previously provisioned
installation. Existing populated installations require explicit --allow-existing
maintenance while every application/Keycloak/Temporal writer is stopped.
"""
import argparse
import asyncio
import os
import re
import sys

import asyncpg

ROLE_PASSWORDS = {
    "inout_app": "APP_DB_PASSWORD",
    "inout_migrator": "MIGRATION_DB_PASSWORD",
    "inout_keycloak": "KEYCLOAK_DB_PASSWORD",
    "inout_temporal": "TEMPORAL_DB_PASSWORD",
}


def identifier(value):
    return '"' + value.replace('"', '""') + '"'


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def required_password(name):
    value = os.environ.get(name, "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,}", value):
        raise RuntimeError(f"{name} must contain at least 32 random URL-safe characters")
    return value


async def connect(database="inout", *, user="inout", password=None):
    return await asyncpg.connect(
        host=os.environ.get("PROVISION_HOST", "postgres-primary"),
        port=int(os.environ.get("PROVISION_PORT", "5432")),
        user=user, password=password, database=database, timeout=10,
        command_timeout=30,
        # Errors must never include password-containing SQL statements.
        server_settings={"application_name": "inout-role-provisioner"},
    )


async def transfer_schema(connection, schema, role):
    await connection.execute(f"CREATE SCHEMA IF NOT EXISTS {identifier(schema)} AUTHORIZATION {identifier(role)}")
    await connection.execute(f"ALTER SCHEMA {identifier(schema)} OWNER TO {identifier(role)}")
    # Avoid system/extension objects and transfer only this application's schema.
    objects = await connection.fetch("""
        SELECT c.relname, c.relkind::text AS relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','S','f')
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass
              AND d.objid=c.oid AND d.deptype='e')
        ORDER BY CASE WHEN c.relkind='S' THEN 1 ELSE 0 END, c.relname
    """, schema)
    types = {"r": "TABLE", "p": "TABLE", "v": "VIEW", "m": "MATERIALIZED VIEW", "S": "SEQUENCE", "f": "FOREIGN TABLE"}
    for item in objects:
        await connection.execute(f"ALTER {types[item['relkind']]} {identifier(schema)}.{identifier(item['relname'])} OWNER TO {identifier(role)}")
    await connection.execute(f"REVOKE ALL ON SCHEMA {identifier(schema)} FROM PUBLIC")
    await connection.execute(f"REVOKE ALL ON ALL TABLES IN SCHEMA {identifier(schema)} FROM PUBLIC")
    await connection.execute(f"REVOKE ALL ON ALL SEQUENCES IN SCHEMA {identifier(schema)} FROM PUBLIC")


async def grant_runtime(connection):
    await connection.execute("GRANT USAGE ON SCHEMA public TO inout_app")
    await connection.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO inout_app")
    await connection.execute("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO inout_app")
    await connection.execute("ALTER DEFAULT PRIVILEGES FOR ROLE inout_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO inout_app")
    await connection.execute("ALTER DEFAULT PRIVILEGES FOR ROLE inout_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO inout_app")
    if await connection.fetchval("SELECT to_regclass('public.alembic_version') IS NOT NULL"):
        await connection.execute("REVOKE ALL ON TABLE public.alembic_version FROM inout_app")


async def verify_existing(connection, passwords):
    for role in ROLE_PASSWORDS:
        safe = await connection.fetchval("""SELECT NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
            AND NOT rolreplication AND NOT rolbypassrls FROM pg_roles WHERE rolname=$1""", role)
        if safe is not True:
            raise RuntimeError("Database role provisioning is incomplete; use the documented maintenance procedure")
    if await connection.fetchval("""SELECT COUNT(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
        WHERE r.rolname=ANY($1::text[])""", list(ROLE_PASSWORDS)):
        raise RuntimeError("Service roles have unexpected memberships; maintenance is required")
    schema_owners = dict(await connection.fetch("""SELECT nspname, pg_get_userbyid(nspowner)
        FROM pg_namespace WHERE nspname IN ('public','keycloak')"""))
    if schema_owners != {"public": "inout_migrator", "keycloak": "inout_keycloak"}:
        raise RuntimeError("Schema ownership changed; maintenance is required")
    bad_owners = await connection.fetchval("""SELECT EXISTS(SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('public','keycloak') AND c.relkind IN ('r','p','v','m','S','f')
          AND pg_get_userbyid(c.relowner) <> CASE n.nspname
              WHEN 'public' THEN 'inout_migrator' ELSE 'inout_keycloak' END
          AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass
              AND d.objid=c.oid AND d.deptype='e'))""")
    if bad_owners:
        raise RuntimeError("Application object ownership changed; maintenance is required")
    forbidden = await connection.fetchval("""SELECT
        has_schema_privilege('inout_app','public','CREATE') OR
        has_schema_privilege('inout_app','keycloak','USAGE') OR
        has_schema_privilege('inout_migrator','keycloak','USAGE') OR
        has_schema_privilege('inout_keycloak','public','USAGE') OR
        has_database_privilege('inout_temporal','inout','CONNECT') OR
        has_database_privilege('inout_app','temporal','CONNECT') OR
        has_database_privilege('inout_app','temporal_visibility','CONNECT') OR
        has_database_privilege('inout_keycloak','temporal','CONNECT') OR
        has_database_privilege('inout_migrator','temporal','CONNECT')""")
    if forbidden:
        raise RuntimeError("Unexpected cross-service privileges; maintenance is required")
    for role, database in (("inout_app", "inout"), ("inout_migrator", "inout"),
                           ("inout_keycloak", "inout"), ("inout_temporal", "temporal")):
        try:
            client = await connect(database, user=role, password=passwords[role])
        except asyncpg.InvalidPasswordError:
            raise RuntimeError(
                f"Database authentication failed for scoped role {role}; its configured "
                "service password does not match the persisted credential. Use the "
                "documented existing-volume maintenance procedure; preserve the volume."
            ) from None
        await client.close()
    print("Scoped database credentials, ownership and boundaries verified")


async def provision(args):
    if args.runtime_grants_only:
        url = os.environ.get("DATABASE_URL", "").replace("postgresql+asyncpg://", "postgresql://", 1)
        if not url:
            raise RuntimeError("DATABASE_URL is required for migration grants")
        connection = await asyncpg.connect(url, timeout=10, command_timeout=30)
        try:
            if await connection.fetchval("SELECT current_user") != "inout_migrator":
                raise RuntimeError("Runtime grants must be applied by the migration principal")
            await grant_runtime(connection)
        finally:
            await connection.close()
        print("Application grants applied; migration metadata remains private")
        return

    passwords = {role: required_password(name) for role, name in ROLE_PASSWORDS.items()}
    new_admin_password = required_password("POSTGRES_PASSWORD")
    current_password = os.environ.get("PROVISION_ADMIN_PASSWORD") or new_admin_password
    try:
        connection = await connect(password=current_password)
    except asyncpg.InvalidPasswordError:
        raise RuntimeError(
            "Database administrator authentication failed: the configured credential "
            "does not match the persisted inout role. Changing POSTGRES_PASSWORD or "
            ".env does not rotate an existing database password. Supply the current "
            "credential through POSTGRES_CURRENT_PASSWORD and follow the documented "
            "existing-volume maintenance procedure; preserve the volume."
        ) from None
    try:
        if not await connection.fetchval("SELECT rolsuper FROM pg_roles WHERE rolname=current_user"):
            raise RuntimeError("Provisioning requires the dedicated database administrator")
        marker = await connection.fetchval("SELECT to_regclass('inout_infrastructure.provisioning') IS NOT NULL")
        if marker and not args.allow_existing:
            await verify_existing(connection, passwords)
            print("Existing provisioning verified; no roles or records changed")
            return
        populated = await connection.fetchval("""SELECT EXISTS(SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname IN ('public','keycloak') AND c.relkind IN ('r','p'))""")
        if populated and not args.allow_existing:
            raise RuntimeError("Existing data detected; stop writers and use --apply --allow-existing after backup/rehearsal")
        if not args.apply:
            print("Plan: provision four non-superuser roles; isolate app/identity/Temporal privileges; rotate administrator password")
            return
        if args.allow_existing:
            writers = await connection.fetchval("""SELECT COUNT(*) FROM pg_stat_activity
                WHERE pid <> pg_backend_pid() AND backend_type='client backend'
                  AND datname IN ('inout','temporal','temporal_visibility')
                  AND usename=ANY($1::text[])""", ["inout", *ROLE_PASSWORDS])
            if writers:
                raise RuntimeError("Stop all API, worker, initialization, Keycloak, Temporal and maintenance DB clients before applying")
        for role, password in passwords.items():
            if not await connection.fetchval("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1)", role):
                await connection.execute(f"CREATE ROLE {identifier(role)}")
            await connection.execute(f"ALTER ROLE {identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD {literal(password)}")
            memberships = await connection.fetch("""SELECT p.rolname FROM pg_auth_members m
                JOIN pg_roles p ON p.oid=m.roleid JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=$1""", role)
            for membership in memberships:
                await connection.execute(f"REVOKE {identifier(membership['rolname'])} FROM {identifier(role)}")
        await connection.execute("REVOKE ALL ON DATABASE inout FROM PUBLIC")
        await connection.execute("REVOKE ALL ON DATABASE inout FROM inout_app, inout_migrator, inout_keycloak, inout_temporal")
        await connection.execute("GRANT CONNECT ON DATABASE inout TO inout_app, inout_migrator, inout_keycloak")
        # Install the only required trusted extension as the administrator;
        # migration clients do not receive database-wide CREATE privileges.
        await connection.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public")
        await transfer_schema(connection, "public", "inout_migrator")
        await transfer_schema(connection, "keycloak", "inout_keycloak")
        await connection.execute("REVOKE ALL ON SCHEMA public FROM inout_app")
        await connection.execute("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM inout_app")
        await connection.execute("REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM inout_app")
        # Remove any legacy explicit cross-schema grants, not just PUBLIC grants.
        await connection.execute("REVOKE ALL ON SCHEMA keycloak FROM inout_app, inout_migrator, inout_temporal")
        await connection.execute("REVOKE ALL ON ALL TABLES IN SCHEMA keycloak FROM inout_app, inout_migrator, inout_temporal")
        await connection.execute("REVOKE ALL ON ALL SEQUENCES IN SCHEMA keycloak FROM inout_app, inout_migrator, inout_temporal")
        await connection.execute("REVOKE ALL ON SCHEMA public FROM inout_keycloak, inout_temporal")
        await connection.execute("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM inout_keycloak, inout_temporal")
        await connection.execute("REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM inout_keycloak, inout_temporal")
        await grant_runtime(connection)
        for database in ("temporal", "temporal_visibility"):
            if not await connection.fetchval("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1)", database):
                await connection.execute(f"CREATE DATABASE {identifier(database)} OWNER inout_temporal")
            await connection.execute(f"ALTER DATABASE {identifier(database)} OWNER TO inout_temporal")
            await connection.execute(f"REVOKE ALL ON DATABASE {identifier(database)} FROM PUBLIC, inout_app, inout_migrator, inout_keycloak")
            await connection.execute(f"GRANT CONNECT ON DATABASE {identifier(database)} TO inout_temporal")
            temporal_connection = await connect(database, password=current_password)
            try:
                await transfer_schema(temporal_connection, "public", "inout_temporal")
            finally:
                await temporal_connection.close()
        await connection.execute("CREATE SCHEMA IF NOT EXISTS inout_infrastructure")
        await connection.execute("REVOKE ALL ON SCHEMA inout_infrastructure FROM PUBLIC, inout_app, inout_migrator, inout_keycloak, inout_temporal")
        await connection.execute("CREATE TABLE IF NOT EXISTS inout_infrastructure.provisioning(version integer PRIMARY KEY)")
        await connection.execute("INSERT INTO inout_infrastructure.provisioning VALUES(1) ON CONFLICT DO NOTHING")
        await connection.execute(f"ALTER ROLE inout PASSWORD {literal(new_admin_password)}")
        await verify_existing(connection, passwords)
        print("Scoped ownership and credential rotation applied; application records preserved")
    finally:
        await connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--allow-existing", action="store_true")
    parser.add_argument("--runtime-grants-only", action="store_true")
    args = parser.parse_args()
    try:
        asyncio.run(provision(args))
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
    except Exception as error:
        # Database exception text can contain password-bearing SQL; omit it.
        print(f"Database provisioning failed ({type(error).__name__}); credentials were not logged", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
