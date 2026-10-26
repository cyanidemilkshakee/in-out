"""Real Postgres/Redis authorization checks, only against disposable fixtures."""
import argparse
import contextlib
import io
import os
import secrets
import sys
import unittest
from unittest.mock import AsyncMock, patch

import asyncpg
from redis.asyncio import Redis
from redis.exceptions import AuthenticationError, NoPermissionError, ResponseError

sys.path.insert(0, "/maintenance")
import provision_database as provisioning


class InfrastructureAuthorizationTests(unittest.IsolatedAsyncioTestCase):
    async def connection(self, role="inout", database="inout"):
        key = provisioning.ROLE_PASSWORDS.get(role, "POSTGRES_PASSWORD")
        return await provisioning.connect(database, user=role, password=os.environ[key])

    async def test_roles_and_cross_database_isolation(self):
        admin = await self.connection()
        try:
            rows = await admin.fetch("""SELECT rolname, rolsuper, rolcreatedb, rolcreaterole,
                rolreplication, rolbypassrls FROM pg_roles WHERE rolname=ANY($1::text[])""",
                list(provisioning.ROLE_PASSWORDS))
            self.assertEqual(len(rows), 4)
            self.assertTrue(all(not any(row[1:]) for row in rows))
            self.assertEqual(await admin.fetchval("SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=ANY($1::text[])", list(provisioning.ROLE_PASSWORDS)), 0)
        finally:
            await admin.close()
        for role, database in (("inout_app", "temporal"), ("inout_keycloak", "temporal"),
                               ("inout_temporal", "inout"), ("inout_migrator", "temporal_visibility")):
            with self.subTest(role=role, database=database):
                with self.assertRaises(asyncpg.InsufficientPrivilegeError):
                    await self.connection(role, database)

    async def test_application_dml_and_schema_ownership(self):
        migration = await self.connection("inout_migrator")
        app = await self.connection("inout_app")
        identity = await self.connection("inout_keycloak")
        try:
            await migration.execute("CREATE TABLE public.fixture_acl(id bigserial PRIMARY KEY, value text NOT NULL)")
            await identity.execute("CREATE TABLE keycloak.fixture_acl(id integer PRIMARY KEY)")
            row = await app.fetchrow("INSERT INTO public.fixture_acl(value) VALUES('synthetic') RETURNING id,value")
            self.assertEqual(row["value"], "synthetic")
            await app.execute("UPDATE public.fixture_acl SET value='updated' WHERE id=$1", row["id"])
            self.assertEqual(await app.fetchval("SELECT value FROM public.fixture_acl WHERE id=$1", row["id"]), "updated")
            await app.execute("DELETE FROM public.fixture_acl WHERE id=$1", row["id"])
            for query in ("CREATE TABLE public.denied(id integer)", "SELECT * FROM keycloak.fixture_acl",
                          "UPDATE public.alembic_version SET version_num=version_num", "ALTER ROLE inout_app SUPERUSER"):
                with self.subTest(query=query):
                    with self.assertRaises(asyncpg.InsufficientPrivilegeError):
                        await app.execute(query)
            for client, query in ((identity, "SELECT * FROM public.fixture_acl"),
                                  (migration, "CREATE TABLE keycloak.denied(id integer)")):
                with self.assertRaises(asyncpg.InsufficientPrivilegeError):
                    await client.execute(query)
        finally:
            await migration.execute("DROP TABLE IF EXISTS public.fixture_acl")
            await identity.execute("DROP TABLE IF EXISTS keycloak.fixture_acl")
            await app.close()
            await migration.close()
            await identity.close()

    async def test_temporal_owns_only_its_databases(self):
        for database in ("temporal", "temporal_visibility"):
            client = await self.connection("inout_temporal", database)
            try:
                await client.execute("CREATE TABLE public.fixture_workflow(id integer PRIMARY KEY)")
                await client.execute("INSERT INTO public.fixture_workflow VALUES(1)")
                self.assertEqual(await client.fetchval("SELECT count(*) FROM public.fixture_workflow"), 1)
                await client.execute("DROP TABLE public.fixture_workflow")
                with self.assertRaises(asyncpg.InsufficientPrivilegeError):
                    await client.execute("CREATE DATABASE denied_fixture")
            finally:
                await client.close()

    async def test_provisioning_is_idempotent_and_existing_rotation_preserves_records(self):
        # Explicit maintenance can recover legacy table ownership and is safely
        # repeatable. No service fixture client remains open while it applies.
        admin = await self.connection()
        await admin.execute("CREATE TABLE IF NOT EXISTS public.fixture_preserved(id integer PRIMARY KEY, value text)")
        await admin.execute("INSERT INTO public.fixture_preserved VALUES(1,'preserved') ON CONFLICT DO NOTHING")
        await admin.close()
        old_application_password = os.environ["APP_DB_PASSWORD"]
        os.environ["PROVISION_ADMIN_PASSWORD"] = os.environ["POSTGRES_PASSWORD"]
        os.environ["POSTGRES_PASSWORD"] = secrets.token_urlsafe(32)
        os.environ["APP_DB_PASSWORD"] = secrets.token_urlsafe(32)
        args = argparse.Namespace(apply=True, allow_existing=True, runtime_grants_only=False)
        await provisioning.provision(args)
        os.environ.pop("PROVISION_ADMIN_PASSWORD")
        with self.assertRaises(asyncpg.InvalidPasswordError):
            await provisioning.connect(user="inout_app", password=old_application_password)
        await provisioning.provision(argparse.Namespace(apply=True, allow_existing=False, runtime_grants_only=False))
        app = await self.connection("inout_app")
        migration = await self.connection("inout_migrator")
        try:
            self.assertEqual(await app.fetchval("SELECT value FROM public.fixture_preserved WHERE id=1"), "preserved")
            self.assertEqual(await migration.fetchval("SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.fixture_preserved'::regclass"), "inout_migrator")
            await migration.execute("DROP TABLE public.fixture_preserved")
        finally:
            await app.close()
            await migration.close()

    async def test_provisioning_refuses_active_writers(self):
        app = await self.connection("inout_app")
        try:
            with self.assertRaisesRegex(RuntimeError, "Stop all"):
                await provisioning.provision(argparse.Namespace(apply=True, allow_existing=True, runtime_grants_only=False))
            self.assertEqual(await app.fetchval("SELECT 1"), 1)
        finally:
            await app.close()

    async def test_admin_credential_mismatch_is_actionable_without_mutation(self):
        admin = await self.connection()
        wrong_password = secrets.token_urlsafe(32)
        try:
            before = await admin.fetch("SELECT rolname, rolsuper, rolcanlogin FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname", list(provisioning.ROLE_PASSWORDS))
            with patch.dict(os.environ, {"POSTGRES_PASSWORD": wrong_password,
                                        "PROVISION_ADMIN_PASSWORD": wrong_password}):
                with self.assertRaisesRegex(RuntimeError, "administrator authentication failed") as rejected:
                    await provisioning.provision(argparse.Namespace(apply=True, allow_existing=False, runtime_grants_only=False))
            diagnostic = str(rejected.exception)
            self.assertIn("POSTGRES_CURRENT_PASSWORD", diagnostic)
            self.assertIn("preserve the volume", diagnostic)
            self.assertNotIn(wrong_password, diagnostic)
            self.assertTrue(rejected.exception.__suppress_context__)
            after = await admin.fetch("SELECT rolname, rolsuper, rolcanlogin FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname", list(provisioning.ROLE_PASSWORDS))
            self.assertEqual(before, after)
            await provisioning.verify_existing(admin, {role: os.environ[key]
                for role, key in provisioning.ROLE_PASSWORDS.items()})
        finally:
            await admin.close()

    async def test_scoped_credential_mismatch_names_only_the_failed_role(self):
        args = argparse.Namespace(apply=True, allow_existing=False, runtime_grants_only=False)
        for role, key in provisioning.ROLE_PASSWORDS.items():
            with self.subTest(role=role):
                wrong_password = secrets.token_urlsafe(32)
                with patch.dict(os.environ, {key: wrong_password,
                                            "PROVISION_ADMIN_PASSWORD": os.environ["POSTGRES_PASSWORD"]}):
                    with self.assertRaisesRegex(RuntimeError, f"scoped role {role}") as rejected:
                        await provisioning.provision(args)
                diagnostic = str(rejected.exception)
                self.assertNotIn("administrator authentication failed", diagnostic)
                self.assertNotIn(wrong_password, diagnostic)
                self.assertTrue(rejected.exception.__suppress_context__)
                # A failed normal-start verification must not rotate credentials.
                client = await self.connection(role, "temporal" if role == "inout_temporal" else "inout")
                await client.close()

    async def test_provisioning_refuses_unmarked_existing_data_and_permission_drift(self):
        admin = await self.connection()
        try:
            await admin.execute("ALTER TABLE inout_infrastructure.provisioning RENAME TO fixture_saved_provisioning")
            try:
                with self.assertRaisesRegex(RuntimeError, "Existing data detected"):
                    await provisioning.provision(argparse.Namespace(apply=True, allow_existing=False, runtime_grants_only=False))
            finally:
                await admin.execute("ALTER TABLE inout_infrastructure.fixture_saved_provisioning RENAME TO provisioning")
            await admin.execute("GRANT CREATE ON SCHEMA public TO inout_app")
            try:
                with self.assertRaisesRegex(RuntimeError, "Unexpected cross-service privileges"):
                    await provisioning.provision(argparse.Namespace(apply=True, allow_existing=False, runtime_grants_only=False))
            finally:
                await admin.execute("REVOKE CREATE ON SCHEMA public FROM inout_app")
        finally:
            await admin.close()

    def redis(self, username=None, password_key=None, **options):
        return Redis(host="redis", username=username,
            password=os.environ[password_key] if password_key else None, decode_responses=True, **options)

    async def test_redis_scoped_users_authenticate_negotiate_and_reconnect(self):
        for username, password_key in (("inout-quota", "REDIS_QUOTA_PASSWORD"),
                                       ("inout-gateway", "REDIS_GATEWAY_PASSWORD"),
                                       ("inout-events", "REDIS_EVENTS_PASSWORD")):
            for protocol in (2, 3):
                with self.subTest(username=username, protocol=protocol):
                    client = self.redis(username, password_key, protocol=protocol)
                    try:
                        self.assertTrue(await client.ping())
                        self.assertTrue(await client.execute_command("SELECT", 0))
                        self.assertTrue(await client.execute_command("CLIENT", "SETINFO", "LIB-NAME", "isolated-acl-test"))
                        # Disconnect only this fixture's own pool. A subsequent
                        # command must establish/authenticate a fresh socket.
                        await client.connection_pool.disconnect()
                        self.assertTrue(await client.ping())
                    finally:
                        await client.aclose()

    async def test_redis_scoped_users_cannot_control_other_clients(self):
        # If a future ACL accidentally permits one of these, the zero duration
        # and nonexistent client ID remain harmless. Require NOPERM specifically,
        # so argument errors cannot make a broken authorization test pass.
        commands = (("CLIENT", "PAUSE", "0", "ALL"),
                    ("CLIENT", "KILL", "ID", "0"),
                    ("CLIENT", "UNBLOCK", "0", "TIMEOUT"),
                    ("CLIENT", "LIST"))
        for username, password_key in (("inout-quota", "REDIS_QUOTA_PASSWORD"),
                                       ("inout-gateway", "REDIS_GATEWAY_PASSWORD"),
                                       ("inout-events", "REDIS_EVENTS_PASSWORD")):
            client = self.redis(username, password_key)
            try:
                self.assertTrue(await client.ping())
                for command in commands:
                    with self.subTest(username=username, command=command[1]):
                        with self.assertRaises(NoPermissionError):
                            await client.execute_command(*command)
                self.assertTrue(await client.ping())
            finally:
                await client.aclose()

    async def test_redis_denies_anonymous_and_scopes_quota_commands_and_keys(self):
        anonymous = self.redis()
        quota = self.redis("inout-quota", "REDIS_QUOTA_PASSWORD")
        try:
            with self.assertRaises(AuthenticationError):
                await anonymous.ping()
            self.assertTrue(await quota.ping())
            key = "inout:security-limits:fixture"
            self.assertEqual(await quota.eval("local n=redis.call('INCR',KEYS[1]); redis.call('EXPIRE',KEYS[1],2); return n", 1, key), 1)
            self.assertEqual(await quota.get(key), "1")
            data_key = "inout:security-limits:fixture-data"
            self.assertEqual(await quota.eval("local n=redis.call('INCRBY',KEYS[1],12); redis.call('EXPIRE',KEYS[1],2); return n", 1, data_key), 12)
            self.assertGreater(await quota.ttl(data_key), 0)
            audit_key = "inout:security-limits:fixture-audit"
            self.assertTrue(await quota.set(audit_key, "1", nx=True, ex=2))
            self.assertIsNone(await quota.set(audit_key, "2", nx=True, ex=2))
            revoked_key = "inout:auth:revocation:token:fixture"
            self.assertTrue(await quota.set(revoked_key, "1", ex=2))
            self.assertEqual(await quota.mget(revoked_key), ["1"])
            lease = "inout:presence-lease:{streams}:fixture"
            self.assertEqual(await quota.eval("local t=redis.call('TIME'); redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',0); redis.call('ZADD',KEYS[1],t[1],'fixture'); redis.call('EXPIRE',KEYS[1],2); return redis.call('ZCARD',KEYS[1])", 1, lease), 1)
            self.assertIsNotNone(await quota.zscore(lease, "fixture"))
            self.assertEqual(await quota.zrem(lease, "fixture"), 1)
            for command in (("GET", "foreign:key"), ("GET", "inout:write-rate:fixture"),
                            ("GET", "inout:auth:other:fixture"),
                            ("INCR", "ratelimit:fixture"), ("PUBLISH", "presence:updates", "synthetic"),
                            ("CONFIG", "GET", "*"), ("FLUSHALL",),
                            ("EVAL", "return redis.call('GET','foreign:key')", "0")):
                with self.subTest(command=command[0]):
                    with self.assertRaises(ResponseError):
                        await quota.execute_command(*command)
        finally:
            await anonymous.aclose()
            await quota.aclose()

    async def test_redis_gateway_user_owns_only_native_rate_limit_counters(self):
        gateway = self.redis("inout-gateway", "REDIS_GATEWAY_PASSWORD")
        try:
            self.assertTrue(await gateway.ping())
            key = "ratelimit:disposable-infrastructure-fixture"
            script = "local n=redis.call('INCR',KEYS[1]); redis.call('EXPIRE',KEYS[1],2); return n"
            self.assertEqual(await gateway.eval(script, 1, key), 1)
            self.assertEqual(await gateway.eval(script, 1, key), 2)
            self.assertIn("redis_version", await gateway.info("server"))
            for command in (("GET", key), ("INCR", "inout:security-limits:fixture"),
                            ("INCR", "inout:presence-lease:fixture"), ("INCR", "foreign:key"),
                            ("PUBLISH", "presence:updates", "synthetic"), ("CONFIG", "GET", "*"),
                            ("ACL", "LIST"), ("FLUSHALL",),
                            ("EVAL", "return redis.call('INCR',KEYS[1])", "1", "foreign:key")):
                with self.subTest(command=command[0]):
                    with self.assertRaises(ResponseError):
                        await gateway.execute_command(*command)
        finally:
            await gateway.aclose()

    async def test_redis_event_channel_cannot_access_keys_or_other_channels(self):
        events = self.redis("inout-events", "REDIS_EVENTS_PASSWORD")
        subscriber = events.pubsub()
        try:
            await subscriber.subscribe("presence:updates")
            await subscriber.get_message(timeout=2)
            self.assertEqual(await events.publish("presence:updates", "synthetic"), 1)
            message = await subscriber.get_message(timeout=2)
            self.assertEqual(message["data"], "synthetic")
            for command in (("GET", "inout:security-limits:fixture"), ("INCR", "ratelimit:fixture"),
                            ("PUBLISH", "foreign:channel", "synthetic"),
                            ("EVAL", "return 1", "0"), ("ACL", "LIST")):
                with self.subTest(command=command[0]):
                    with self.assertRaises(ResponseError):
                        await events.execute_command(*command)
        finally:
            await subscriber.aclose()
            await events.aclose()


class ProvisioningDiagnosticRedactionTests(unittest.TestCase):
    def test_cli_database_exception_never_discloses_password_bearing_sql(self):
        secret = secrets.token_urlsafe(32)
        error = asyncpg.PostgresError(f"ALTER ROLE inout PASSWORD '{secret}'")
        output = io.StringIO()
        with patch.object(provisioning, "provision", AsyncMock(side_effect=error)), \
             patch.object(sys, "argv", ["provision_database.py", "--apply"]), \
             contextlib.redirect_stderr(output):
            with self.assertRaises(SystemExit) as exited:
                provisioning.main()
        self.assertEqual(exited.exception.code, 1)
        self.assertIn("Database provisioning failed (PostgresError)", output.getvalue())
        self.assertNotIn(secret, output.getvalue())
        self.assertNotIn("ALTER ROLE", output.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
