import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import {
  POSTGRES_SCHEMA_SQL,
  POSTGRES_SCHEMA_VERSION,
} from "../backend/postgresSchema.cjs";

const argumentsList = process.argv.slice(2);
const replaceDestination = argumentsList.includes("--replace");
const sourceArgument = argumentsList.find((argument) => !argument.startsWith("--"));
const sourcePath = path.resolve(
  process.cwd(),
  sourceArgument ?? ".data/inout.sqlite"
);

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required. Point it at the destination PostgreSQL database."
  );
}
if (!existsSync(sourcePath)) {
  throw new Error(`SQLite source file was not found: ${sourcePath}`);
}

const sqlite = new DatabaseSync(sourcePath, { readOnly: true });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: 5_000,
  ssl:
    process.env.PGSSL === "true"
      ? {
          rejectUnauthorized:
            process.env.PGSSL_REJECT_UNAUTHORIZED !== "false",
        }
      : undefined,
});

function rows(table) {
  const allowed = new Set([
    "app_metadata",
    "subjects",
    "people",
    "hardware_assets",
    "checkpoints",
    "movements",
    "alerts",
    "access_permissions",
    "permission_requests",
    "notifications",
    "alert_rules",
    "audit_events",
    "movement_notes",
    "admin_accounts",
  ]);
  if (!allowed.has(table)) throw new Error(`Unsupported SQLite table: ${table}`);
  return sqlite.prepare(`SELECT * FROM ${table}`).all();
}

function parseJson(value) {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

async function insertSimpleJsonTable(
  client,
  table,
  idColumn,
  sourceRows
) {
  if (sourceRows.length === 0) return;
  const allowed = new Set([
    "people:subject_id",
    "hardware_assets:subject_id",
    "checkpoints:id",
    "alert_rules:id",
  ]);
  if (!allowed.has(`${table}:${idColumn}`)) {
    throw new Error(`Unsupported PostgreSQL table: ${table}.${idColumn}`);
  }
  await client.query(
    `INSERT INTO ${table} (${idColumn}, data)
     SELECT item.${idColumn}, item.data
     FROM jsonb_to_recordset($1::jsonb)
       AS item(${idColumn} text, data jsonb)`,
    [
      JSON.stringify(
        sourceRows.map((row) => ({
          [idColumn]: row[idColumn],
          data: parseJson(row.data),
        }))
      ),
    ]
  );
}

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('inout-sqlite-import'))"
    );
    await client.query(POSTGRES_SCHEMA_SQL);

    const destination = await client.query(
      "SELECT count(*)::int AS count FROM subjects"
    );
    if (destination.rows[0].count > 0 && !replaceDestination) {
      throw new Error(
        "The PostgreSQL destination is not empty. Use a fresh database or pass --replace to truncate and replace its IN/OUT data."
      );
    }
    if (replaceDestination) {
      await client.query(
        `TRUNCATE TABLE
           movement_notes, audit_events, alert_rules, notifications,
           permission_requests, access_permissions, alerts, movements,
           checkpoints, hardware_assets, people, subjects, admin_accounts,
           app_metadata
         RESTART IDENTITY CASCADE`
      );
    }

    const subjects = rows("subjects");
    if (subjects.length > 0) {
      await client.query(
        `INSERT INTO subjects (id, kind, barcode)
         SELECT item.id, item.kind, item.barcode
         FROM jsonb_to_recordset($1::jsonb)
           AS item(id text, kind text, barcode text)`,
        [JSON.stringify(subjects)]
      );
    }
    await insertSimpleJsonTable(client, "people", "subject_id", rows("people"));
    await insertSimpleJsonTable(
      client,
      "hardware_assets",
      "subject_id",
      rows("hardware_assets")
    );
    await insertSimpleJsonTable(
      client,
      "checkpoints",
      "id",
      rows("checkpoints")
    );

    const movements = rows("movements").map((row) => {
      const data = parseJson(row.data);
      return {
        id: row.id,
        subject_id: row.subject_id,
        checkpoint_id: row.checkpoint_id,
        occurred_at: row.occurred_at ?? data.createdAt,
        denial_code: row.denial_code ?? data.denialCode ?? null,
        result: row.result ?? data.result,
        direction: row.direction ?? data.direction,
        scan_type: row.scan_type ?? data.scanType ?? "manual",
        subject_type: row.subject_type ?? data.subjectType,
        sync_state: row.sync_state ?? data.syncState ?? "synced",
        data,
      };
    });
    if (movements.length > 0) {
      await client.query(
        `INSERT INTO movements (
           id, subject_id, checkpoint_id, occurred_at, denial_code, result,
           direction, scan_type, subject_type, sync_state, data
         )
         SELECT
           item.id, item.subject_id, item.checkpoint_id, item.occurred_at,
           item.denial_code, item.result, item.direction, item.scan_type,
           item.subject_type, item.sync_state, item.data
         FROM jsonb_to_recordset($1::jsonb) AS item(
           id text,
           subject_id text,
           checkpoint_id text,
           occurred_at timestamptz,
           denial_code text,
           result text,
           direction text,
           scan_type text,
           subject_type text,
           sync_state text,
           data jsonb
         )`,
        [JSON.stringify(movements)]
      );
    }

    const alerts = rows("alerts").map((row) => ({
      id: row.id,
      source_event_id: row.source_event_id,
      created_at: row.created_at,
      data: parseJson(row.data),
    }));
    if (alerts.length > 0) {
      await client.query(
        `INSERT INTO alerts (id, source_event_id, created_at, data)
         SELECT item.id, item.source_event_id, item.created_at, item.data
         FROM jsonb_to_recordset($1::jsonb)
           AS item(
             id text,
             source_event_id text,
             created_at timestamptz,
             data jsonb
           )`,
        [JSON.stringify(alerts)]
      );
    }

    const permissions = rows("access_permissions").map((row) => ({
      id: row.id,
      subject_id: row.subject_id,
      data: parseJson(row.data),
    }));
    if (permissions.length > 0) {
      await client.query(
        `INSERT INTO access_permissions (id, subject_id, data)
         SELECT item.id, item.subject_id, item.data
         FROM jsonb_to_recordset($1::jsonb)
           AS item(id text, subject_id text, data jsonb)`,
        [JSON.stringify(permissions)]
      );
    }

    const requests = rows("permission_requests").map((row) => ({
      id: row.id,
      subject_id: row.subject_id,
      created_at: row.created_at,
      data: parseJson(row.data),
    }));
    if (requests.length > 0) {
      await client.query(
        `INSERT INTO permission_requests (id, subject_id, created_at, data)
         SELECT item.id, item.subject_id, item.created_at, item.data
         FROM jsonb_to_recordset($1::jsonb)
           AS item(
             id text,
             subject_id text,
             created_at timestamptz,
             data jsonb
           )`,
        [JSON.stringify(requests)]
      );
    }

    for (const [table, sourceRows] of [
      ["notifications", rows("notifications")],
      ["audit_events", rows("audit_events")],
    ]) {
      if (sourceRows.length === 0) continue;
      await client.query(
        `INSERT INTO ${table} (id, created_at, data)
         SELECT item.id, item.created_at, item.data
         FROM jsonb_to_recordset($1::jsonb)
           AS item(id text, created_at timestamptz, data jsonb)`,
        [
          JSON.stringify(
            sourceRows.map((row) => ({
              id: row.id,
              created_at: row.created_at,
              data: parseJson(row.data),
            }))
          ),
        ]
      );
    }
    await insertSimpleJsonTable(
      client,
      "alert_rules",
      "id",
      rows("alert_rules")
    );

    const notes = rows("movement_notes");
    if (notes.length > 0) {
      await client.query(
        `INSERT INTO movement_notes (id, event_id, note, created_at)
         SELECT item.id, item.event_id, item.note, item.created_at
         FROM jsonb_to_recordset($1::jsonb)
           AS item(
             id bigint,
             event_id text,
             note text,
             created_at timestamptz
           )`,
        [JSON.stringify(notes)]
      );
      await client.query(
        `SELECT setval(
           pg_get_serial_sequence('movement_notes', 'id'),
           (SELECT max(id) FROM movement_notes),
           true
         )`
      );
    }

    const admins = rows("admin_accounts").map((row) => ({
      id: row.id,
      name: row.name,
      nickname: row.nickname,
      email: row.email,
      password_hash: row.password_hash,
      avatar_data_url: row.avatar_data_url,
      auto_lock: row.auto_lock,
      settings: parseJson(row.settings_json),
      is_current: Boolean(row.is_current),
      created_at: row.created_at,
    }));
    if (admins.length > 0) {
      await client.query(
        `INSERT INTO admin_accounts (
           id, name, nickname, email, password_hash, avatar_data_url,
           auto_lock, settings, is_current, created_at
         )
         SELECT
           item.id, item.name, item.nickname, item.email, item.password_hash,
           item.avatar_data_url, item.auto_lock, item.settings,
           item.is_current, item.created_at
         FROM jsonb_to_recordset($1::jsonb) AS item(
           id text,
           name text,
           nickname text,
           email text,
           password_hash text,
           avatar_data_url text,
           auto_lock text,
           settings jsonb,
           is_current boolean,
           created_at timestamptz
         )`,
        [JSON.stringify(admins)]
      );
    }

    const metadata = new Map(
      rows("app_metadata").map((row) => [row.key, row.value])
    );
    await client.query(
      `INSERT INTO app_metadata (key, value)
       VALUES
         ('schema_version', $1),
         ('seed_anchor', $2),
         ('sqlite_migrated_at', $3),
         ('sqlite_source_name', $4)`,
      [
        POSTGRES_SCHEMA_VERSION,
        metadata.get("seed_anchor") ?? new Date().toISOString(),
        new Date().toISOString(),
        path.basename(sourcePath),
      ]
    );

    await client.query("COMMIT");
    const countResult = await client.query(`
      SELECT
        (SELECT count(*) FROM subjects)::int AS subjects,
        (SELECT count(*) FROM movements)::int AS movements,
        (SELECT count(*) FROM alerts)::int AS alerts,
        (SELECT count(*) FROM audit_events)::int AS audit_events,
        (SELECT count(*) FROM admin_accounts)::int AS admins
    `);
    return countResult.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

try {
  const counts = await migrate();
  console.log(`Migrated SQLite data from ${sourcePath}`);
  console.log(
    `PostgreSQL rows: ${counts.subjects} subjects, ${counts.movements} movements, ${counts.alerts} alerts, ${counts.audit_events} audit events, ${counts.admins} admins`
  );
  console.log("The SQLite source was retained as a backup.");
} finally {
  sqlite.close();
  await pool.end();
}
