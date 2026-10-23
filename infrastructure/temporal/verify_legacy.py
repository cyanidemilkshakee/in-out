"""Read-only startup gate for the existing four-shard Temporal 1.26 cluster.

This never initializes a database, upgrades a schema, or creates an origin marker.
Fixture self-tests require explicit isolation and roll every mutation back.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import uuid

import asyncpg
from google.protobuf import descriptor_pb2, descriptor_pool, message_factory
from google.protobuf.message import DecodeError

VERSIONS = {"temporal": "1.14", "temporal_visibility": "1.7"}
SHARDS = 4
CLUSTER = "active"
MARKER = "inout_temporal_bootstrap"
# EncodingType.String() in the official Go API uses PascalCase for persistence.
ENCODING = "Proto3"


class LegacyRejected(RuntimeError):
    pass


def metadata_type():
    # Read only the stable fields from the official 1.26 persistence proto:
    # proto/internal/temporal/server/api/persistence/v1/cluster_metadata.proto.
    # Protobuf safely skips/preserves the remaining fields; no hand-written
    # binary parsing or regenerated dependency package is necessary.
    description = descriptor_pb2.FileDescriptorProto(
        name="inout_temporal_legacy_cluster.proto", package="inout.legacy", syntax="proto3")
    message = description.message_type.add(name="ClusterMetadata")
    for name, number, kind in (("cluster_name", 1, descriptor_pb2.FieldDescriptorProto.TYPE_STRING),
                               ("history_shard_count", 2, descriptor_pb2.FieldDescriptorProto.TYPE_INT32),
                               ("cluster_id", 3, descriptor_pb2.FieldDescriptorProto.TYPE_STRING)):
        message.field.add(name=name, number=number, type=kind,
                          label=descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL)
    pool = descriptor_pool.DescriptorPool()
    pool.Add(description)
    return message_factory.GetMessageClass(pool.FindMessageTypeByName("inout.legacy.ClusterMetadata"))


ClusterMetadata = metadata_type()


def connection_options():
    if os.environ.get("INOUT_TEMPORAL_LEGACY") != "1":
        raise LegacyRejected("Legacy Temporal recovery requires the explicitly selected compatibility overlay")
    if os.environ.get("SQL_USER", "inout_temporal") != "inout_temporal":
        raise LegacyRejected("Legacy Temporal verification requires the scoped inout_temporal role")
    if os.environ.get("NUM_HISTORY_SHARDS") != str(SHARDS):
        raise LegacyRejected("Legacy Temporal recovery requires the verified four-shard configuration")
    password = os.environ.get("SQL_PASSWORD") or os.environ.get("TEMPORAL_DB_PASSWORD")
    if not password:
        raise LegacyRejected("SQL_PASSWORD or TEMPORAL_DB_PASSWORD is required")
    return dict(host=os.environ.get("SQL_HOST", "postgres-primary"),
                port=int(os.environ.get("SQL_PORT", "5432")), user="inout_temporal",
                password=password, timeout=10, command_timeout=30,
                server_settings={"application_name": "inout-temporal-legacy-verifier",
                                 "default_transaction_read_only": "on"})


async def inspect(connection, database):
    if database not in VERSIONS:
        raise LegacyRejected("Unexpected Temporal database requested")
    safe = await connection.fetchval("""SELECT rolname='inout_temporal' AND NOT rolsuper
        AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication
        AND NOT rolbypassrls AND NOT rolinherit FROM pg_roles WHERE rolname=current_user""")
    memberships = await connection.fetchval("""SELECT count(*) FROM pg_auth_members
        WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)""")
    owner = await connection.fetchval("""SELECT datname=$1 AND pg_get_userbyid(datdba)=current_user
        FROM pg_database WHERE datname=current_database()""", database)
    schema_owner = await connection.fetchval("""SELECT pg_get_userbyid(nspowner)=current_user
        FROM pg_namespace WHERE nspname='public'""")
    bad_objects = await connection.fetchval("""SELECT EXISTS(SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')
        AND pg_get_userbyid(c.relowner) <> current_user
        AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass
            AND d.objid=c.oid AND d.deptype='e'))""")
    if safe is not True or memberships or owner is not True or schema_owner is not True or bad_objects:
        raise LegacyRejected("Legacy Temporal recovery requires scoped role flags, memberships and database/schema/object ownership")
    if await connection.fetchval(f"SELECT to_regclass('public.{MARKER}') IS NOT NULL"):
        raise LegacyRejected("A Temporal origin/upgrade marker exists; the legacy overlay must not start a newer cluster")
    if not await connection.fetchval("SELECT to_regclass('public.schema_version') IS NOT NULL"):
        raise LegacyRejected("Existing legacy Temporal schema metadata is required")
    versions = await connection.fetch("SELECT curr_version FROM public.schema_version")
    if len(versions) != 1 or versions[0]["curr_version"] != VERSIONS[database]:
        raise LegacyRejected("Temporal schema version does not match the pinned legacy 1.26 server")
    if database == "temporal":
        if not await connection.fetchval("SELECT to_regclass('public.cluster_metadata_info') IS NOT NULL AND to_regclass('public.shards') IS NOT NULL"):
            raise LegacyRejected("Existing legacy Temporal cluster and shard metadata is required")
        rows = await connection.fetch("SELECT cluster_name,data,data_encoding FROM public.cluster_metadata_info")
        if len(rows) != 1 or rows[0]["cluster_name"] != CLUSTER or rows[0]["data_encoding"] != ENCODING:
            raise LegacyRejected("Legacy Temporal recovery requires the existing single active cluster metadata")
        metadata = ClusterMetadata()
        try:
            metadata.ParseFromString(rows[0]["data"])
            uuid.UUID(metadata.cluster_id)
        except (DecodeError, ValueError, TypeError):
            raise LegacyRejected("Legacy Temporal cluster metadata is malformed") from None
        if metadata.cluster_name != CLUSTER or metadata.history_shard_count != SHARDS:
            raise LegacyRejected("Persisted Temporal cluster name/shard count does not match the recovery configuration")
        shards = await connection.fetch("SELECT shard_id FROM public.shards ORDER BY shard_id")
        if [row["shard_id"] for row in shards] != list(range(1, SHARDS + 1)):
            raise LegacyRejected("Persisted Temporal shard IDs do not match the verified four-shard cluster")


class FixtureRollback(Exception):
    pass


async def fixture_self_test(connections):
    if os.environ.get("INOUT_TEMPORAL_FIXTURE") != "1":
        raise LegacyRejected("Legacy guard self-tests require the isolated fixture flag")
    temporal = connections["temporal"]
    visibility = connections["temporal_visibility"]
    original = await temporal.fetchval("SELECT data FROM public.cluster_metadata_info WHERE cluster_name=$1", CLUSTER)
    changed_metadata = ClusterMetadata()
    changed_metadata.ParseFromString(original)
    changed_metadata.history_shard_count = SHARDS + 1
    cases = (
        (visibility, "temporal_visibility", "advanced visibility schema",
         "UPDATE public.schema_version SET curr_version='1.14'", ()),
        (temporal, "temporal", "advanced persistence schema",
         "UPDATE public.schema_version SET curr_version='1.19'", ()),
        (temporal, "temporal", "new-cluster origin marker",
         f"CREATE TABLE public.{MARKER} (origin_minor text)", ()),
        (temporal, "temporal", "mismatched cluster shard count",
         "UPDATE public.cluster_metadata_info SET data=$1 WHERE cluster_name='active'",
         (changed_metadata.SerializeToString(),)),
        (temporal, "temporal", "mismatched persisted shard IDs",
         "UPDATE public.shards SET shard_id=5 WHERE shard_id=4", ()),
        (temporal, "temporal", "malformed cluster metadata",
         "UPDATE public.cluster_metadata_info SET data=$1 WHERE cluster_name='active'", (b"\xff",)),
        (temporal, "temporal", "noncanonical metadata encoding",
         "UPDATE public.cluster_metadata_info SET data_encoding='proto3' WHERE cluster_name='active'", ()),
    )
    for connection, database, label, query, arguments in cases:
        try:
            async with connection.transaction():
                # asyncpg omits READ WRITE when readonly=False, so override the
                # session's read-only default explicitly as the first statement.
                # This affects only this always-rolled-back fixture transaction.
                await connection.execute("SET TRANSACTION READ WRITE")
                await connection.execute(query, *arguments)
                try:
                    await inspect(connection, database)
                except LegacyRejected:
                    print(f"PASS: legacy guard rejects {label}; fixture mutation rolled back")
                else:
                    raise AssertionError(f"Legacy guard accepted {label}")
                raise FixtureRollback()
        except FixtureRollback:
            pass
    # Verify that ordinary verification sessions really enforce read-only SQL.
    try:
        async with temporal.transaction(readonly=True):
            await temporal.execute("UPDATE public.schema_version SET curr_version=curr_version")
    except asyncpg.ReadOnlySQLTransactionError:
        print("PASS: normal legacy verification transaction rejects writes")
    else:
        raise AssertionError("Legacy verification accepted SQL writes")


async def verify(args):
    if args.fixture_self_test and os.environ.get("INOUT_TEMPORAL_FIXTURE") != "1":
        raise LegacyRejected("Legacy guard self-tests require the isolated fixture flag")
    options = connection_options()
    connections = {}
    try:
        for database in VERSIONS:
            connection = await asyncpg.connect(database=database, **options)
            connections[database] = connection
            async with connection.transaction(readonly=True, isolation="repeatable_read"):
                await inspect(connection, database)
        if args.fixture_self_test:
            await fixture_self_test(connections)
            for database, connection in connections.items():
                async with connection.transaction(readonly=True):
                    await inspect(connection, database)
        print("Existing Temporal 1.26 schemas, scoped ownership and four-shard cluster verified; no data changed")
    finally:
        for connection in connections.values():
            await connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture-self-test", action="store_true")
    args = parser.parse_args()
    try:
        asyncio.run(verify(args))
    except LegacyRejected as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
    except Exception as error:
        # Never expose connection errors, SQL text, metadata blobs or passwords.
        print(f"Legacy Temporal verification failed ({type(error).__name__}); credentials were not logged", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
