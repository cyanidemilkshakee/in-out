import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { buildSeedData, type SeedBundle } from "./seedData";
import {
  POSTGRES_SCHEMA_SQL,
  POSTGRES_SCHEMA_VERSION,
} from "./postgresSchema.cjs";

type GlobalDatabase = typeof globalThis & {
  __inOutPool?: Pool;
  __inOutDatabaseInitialization?: Promise<void>;
};

function databaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is required. Start PostgreSQL with `docker compose up -d db` or configure a PostgreSQL connection URL."
    );
  }
  return url;
}

function poolOptions() {
  const ssl =
    process.env.PGSSL === "true"
      ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== "false" }
      : undefined;
  return {
    connectionString: databaseUrl(),
    max: Math.max(1, Number(process.env.PGPOOL_MAX ?? 10)),
    idleTimeoutMillis: Math.max(
      1_000,
      Number(process.env.PGPOOL_IDLE_TIMEOUT_MS ?? 10_000)
    ),
    connectionTimeoutMillis: Math.max(
      1_000,
      Number(process.env.PGPOOL_CONNECTION_TIMEOUT_MS ?? 5_000)
    ),
    ssl,
  };
}

function sharedPool() {
  const shared = globalThis as GlobalDatabase;
  if (!shared.__inOutPool) {
    shared.__inOutPool = new Pool(poolOptions());
    shared.__inOutPool.on("error", (error) => {
      console.error("Unexpected PostgreSQL pool error", error);
    });
  }
  return shared.__inOutPool;
}

export function hashPassword(
  password: string,
  salt = randomBytes(16).toString("hex")
) {
  const digest = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${digest}`;
}

export function verifyPassword(password: string, storedHash: string) {
  const [salt, storedDigest] = storedHash.split(":");
  if (!salt || !storedDigest) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(storedDigest, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function withTransaction<T>(
  operation: (client: PoolClient) => Promise<T>
) {
  const pool = await getDatabase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertJsonRows(
  client: PoolClient,
  table: string,
  idColumn: string,
  values: unknown[]
) {
  if (values.length === 0) return;
  const allowed = new Set([
    "people:subject_id",
    "hardware_assets:subject_id",
    "checkpoints:id",
    "alert_rules:id",
  ]);
  if (!allowed.has(`${table}:${idColumn}`)) {
    throw new Error(`Unsupported seed target: ${table}.${idColumn}`);
  }
  await client.query(
    `INSERT INTO ${table} (${idColumn}, data)
     SELECT item ->> 'id', item
     FROM jsonb_array_elements($1::jsonb) AS item`,
    [JSON.stringify(values)]
  );
}

async function seedDatabase(client: PoolClient, bundle: SeedBundle) {
  const { snapshot } = bundle;
  await client.query(
    `INSERT INTO subjects (id, kind, barcode)
     VALUES ('unknown', 'visitor', 'SYSTEM-UNKNOWN')`
  );
  await client.query(
    `INSERT INTO subjects (id, kind, barcode)
     SELECT item ->> 'id', item ->> 'type', item ->> 'barcode'
     FROM jsonb_array_elements($1::jsonb) AS item`,
    [JSON.stringify(snapshot.people)]
  );
  await client.query(
    `INSERT INTO subjects (id, kind, barcode)
     SELECT item ->> 'id', 'hardware', item ->> 'barcode'
     FROM jsonb_array_elements($1::jsonb) AS item`,
    [JSON.stringify(snapshot.hardwareAssets)]
  );
  await insertJsonRows(client, "people", "subject_id", snapshot.people);
  await insertJsonRows(
    client,
    "hardware_assets",
    "subject_id",
    snapshot.hardwareAssets
  );
  await insertJsonRows(client, "checkpoints", "id", snapshot.checkpoints);

  if (snapshot.movements.length > 0) {
    await client.query(
      `INSERT INTO movements (
         id, subject_id, checkpoint_id, occurred_at, denial_code, result,
         direction, scan_type, subject_type, sync_state, data
       )
       SELECT
         item ->> 'id',
         item ->> 'subjectId',
         item ->> 'checkpointId',
         COALESCE((item ->> 'createdAt')::timestamptz, to_timestamp(0)),
         item ->> 'denialCode',
         item ->> 'result',
         item ->> 'direction',
         COALESCE(item ->> 'scanType', 'manual'),
         item ->> 'subjectType',
         COALESCE(item ->> 'syncState', 'synced'),
         item
       FROM jsonb_array_elements($1::jsonb) AS item`,
      [JSON.stringify(snapshot.movements)]
    );
  }
  if (snapshot.alerts.length > 0) {
    await client.query(
      `INSERT INTO alerts (id, source_event_id, created_at, data)
       SELECT
         item ->> 'id',
         NULLIF(item ->> 'sourceEventId', ''),
         COALESCE((item ->> 'createdAt')::timestamptz, to_timestamp(0)),
         item
       FROM jsonb_array_elements($1::jsonb) AS item`,
      [JSON.stringify(snapshot.alerts)]
    );
  }
  if (snapshot.permissions.length > 0) {
    await client.query(
      `INSERT INTO access_permissions (id, subject_id, data)
       SELECT item ->> 'id', item ->> 'subjectId', item
       FROM jsonb_array_elements($1::jsonb) AS item`,
      [JSON.stringify(snapshot.permissions)]
    );
  }
  if (snapshot.permissionRequests.length > 0) {
    await client.query(
      `INSERT INTO permission_requests (id, subject_id, created_at, data)
       SELECT
         item ->> 'id',
         item ->> 'subjectId',
         (item ->> 'createdAt')::timestamptz,
         item
       FROM jsonb_array_elements($1::jsonb) AS item`,
      [JSON.stringify(snapshot.permissionRequests)]
    );
  }
  if (snapshot.notifications.length > 0) {
    await client.query(
      `INSERT INTO notifications (id, created_at, data)
       SELECT item ->> 'id', (item ->> 'createdAt')::timestamptz, item
       FROM jsonb_array_elements($1::jsonb) AS item`,
      [JSON.stringify(snapshot.notifications)]
    );
  }
  await insertJsonRows(client, "alert_rules", "id", snapshot.alertRules);
  if (snapshot.auditEvents.length > 0) {
    await client.query(
      `INSERT INTO audit_events (id, created_at, data)
       SELECT item ->> 'id', (item ->> 'createdAt')::timestamptz, item
       FROM jsonb_array_elements($1::jsonb) AS item`,
      [JSON.stringify(snapshot.auditEvents)]
    );
  }
  for (const [index, admin] of bundle.admins.entries()) {
    await client.query(
      `INSERT INTO admin_accounts (
         id, name, nickname, email, password_hash, avatar_data_url, auto_lock,
         settings, is_current, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
      [
        admin.id,
        admin.name,
        admin.nickname,
        admin.email,
        hashPassword(admin.password, `inout-seed-${admin.id}`),
        admin.avatarDataUrl,
        admin.autoLock,
        JSON.stringify(admin.settings),
        index === 0,
        admin.createdAt,
      ]
    );
  }
  await client.query(
    `INSERT INTO app_metadata (key, value)
     VALUES ('schema_version', $1), ('seed_anchor', $2)`,
    [POSTGRES_SCHEMA_VERSION, bundle.anchor]
  );
}

async function initializeDatabase(pool: Pool, anchor = new Date()) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('inout-postgres-schema'))"
    );
    await client.query(POSTGRES_SCHEMA_SQL);
    const metadata = await client.query<{ value: string }>(
      "SELECT value FROM app_metadata WHERE key = 'schema_version'"
    );
    if (
      metadata.rows[0]?.value &&
      metadata.rows[0].value !== POSTGRES_SCHEMA_VERSION
    ) {
      throw new Error(
        `Unsupported PostgreSQL schema version ${metadata.rows[0].value}; expected ${POSTGRES_SCHEMA_VERSION}.`
      );
    }
    const subjects = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM subjects"
    );
    if (Number(subjects.rows[0]?.count ?? 0) === 0) {
      await seedDatabase(client, buildSeedData(anchor));
    } else if (!metadata.rows[0]) {
      await client.query(
        `INSERT INTO app_metadata (key, value)
         VALUES ('schema_version', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [POSTGRES_SCHEMA_VERSION]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getDatabase() {
  const shared = globalThis as GlobalDatabase;
  const pool = sharedPool();
  if (!shared.__inOutDatabaseInitialization) {
    shared.__inOutDatabaseInitialization = initializeDatabase(pool).catch(
      (error) => {
        delete shared.__inOutDatabaseInitialization;
        throw error;
      }
    );
  }
  await shared.__inOutDatabaseInitialization;
  return pool;
}

export async function resetDatabaseForTests(anchor = new Date()) {
  if (process.env.NODE_ENV !== "test" && process.env.ALLOW_DATABASE_RESET !== "true") {
    throw new Error("Database reset is only allowed in tests.");
  }
  const pool = await getDatabase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `TRUNCATE TABLE
         movement_notes, audit_events, alert_rules, notifications,
         permission_requests, access_permissions, alerts, movements,
         checkpoints, hardware_assets, people, subjects, admin_accounts,
         app_metadata
       RESTART IDENTITY CASCADE`
    );
    await seedDatabase(client, buildSeedData(anchor));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closeDatabaseForTests() {
  const shared = globalThis as GlobalDatabase;
  if (shared.__inOutPool) {
    await shared.__inOutPool.end();
  }
  delete shared.__inOutPool;
  delete shared.__inOutDatabaseInitialization;
}
