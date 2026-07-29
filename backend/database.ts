import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { buildSeedData, type SeedBundle } from "./seedData";

const SCHEMA_VERSION = "4";

type GlobalDatabase = typeof globalThis & {
  __inOutDatabase?: DatabaseSync;
};

function createSchema(database: DatabaseSync) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS subjects (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('employee', 'visitor', 'hardware')),
      barcode TEXT NOT NULL UNIQUE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS people (
      subject_id TEXT PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE,
      data TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS hardware_assets (
      subject_id TEXT PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE,
      data TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS movements (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES subjects(id),
      checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
      occurred_at TEXT NOT NULL,
      denial_code TEXT,
      result TEXT NOT NULL CHECK (result IN ('approved', 'denied')),
      direction TEXT NOT NULL CHECK (direction IN ('entry', 'exit')),
      scan_type TEXT NOT NULL CHECK (scan_type IN ('auto', 'manual')),
      subject_type TEXT NOT NULL CHECK (subject_type IN ('employee', 'visitor', 'hardware')),
      sync_state TEXT NOT NULL CHECK (sync_state IN ('synced', 'queued', 'conflict')),
      data TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_movements_occurred_at
      ON movements(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_movements_subject
      ON movements(subject_id, occurred_at DESC);
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      source_event_id TEXT REFERENCES movements(id),
      created_at TEXT NOT NULL,
      data TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at DESC);

    CREATE TABLE IF NOT EXISTS access_permissions (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES subjects(id),
      data TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS permission_requests (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES subjects(id),
      created_at TEXT NOT NULL,
      data TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      data TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS alert_rules (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      data TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS movement_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL REFERENCES movements(id) ON DELETE CASCADE,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_movement_notes_event
      ON movement_notes(event_id, id);

    CREATE TABLE IF NOT EXISTS admin_accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      nickname TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      avatar_data_url TEXT NOT NULL,
      auto_lock TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    ) STRICT;
  `);
}

function resetSchema(database: DatabaseSync) {
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS movement_notes;
    DROP TABLE IF EXISTS audit_events;
    DROP TABLE IF EXISTS alert_rules;
    DROP TABLE IF EXISTS notifications;
    DROP TABLE IF EXISTS permission_requests;
    DROP TABLE IF EXISTS access_permissions;
    DROP TABLE IF EXISTS alerts;
    DROP TABLE IF EXISTS movements;
    DROP TABLE IF EXISTS checkpoints;
    DROP TABLE IF EXISTS hardware_assets;
    DROP TABLE IF EXISTS people;
    DROP TABLE IF EXISTS subjects;
    DROP TABLE IF EXISTS admin_accounts;
    DROP TABLE IF EXISTS app_metadata;
    PRAGMA foreign_keys = ON;
  `);
  createSchema(database);
}

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
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

function seedDatabase(database: DatabaseSync, bundle: SeedBundle) {
  const insertSubject = database.prepare(
    "INSERT INTO subjects (id, kind, barcode) VALUES (?, ?, ?)"
  );
  const insertPerson = database.prepare(
    "INSERT INTO people (subject_id, data) VALUES (?, ?)"
  );
  const insertHardware = database.prepare(
    "INSERT INTO hardware_assets (subject_id, data) VALUES (?, ?)"
  );
  const insertCheckpoint = database.prepare(
    "INSERT INTO checkpoints (id, data) VALUES (?, ?)"
  );
  const insertMovement = database.prepare(
    `INSERT INTO movements
      (
        id,
        subject_id,
        checkpoint_id,
        occurred_at,
        denial_code,
        result,
        direction,
        scan_type,
        subject_type,
        sync_state,
        data
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertAlert = database.prepare(
    "INSERT INTO alerts (id, source_event_id, created_at, data) VALUES (?, ?, ?, ?)"
  );
  const insertPermission = database.prepare(
    "INSERT INTO access_permissions (id, subject_id, data) VALUES (?, ?, ?)"
  );
  const insertRequest = database.prepare(
    `INSERT INTO permission_requests
      (id, subject_id, created_at, data) VALUES (?, ?, ?, ?)`
  );
  const insertNotification = database.prepare(
    "INSERT INTO notifications (id, created_at, data) VALUES (?, ?, ?)"
  );
  const insertRule = database.prepare(
    "INSERT INTO alert_rules (id, data) VALUES (?, ?)"
  );
  const insertAudit = database.prepare(
    "INSERT INTO audit_events (id, created_at, data) VALUES (?, ?, ?)"
  );
  const insertAdmin = database.prepare(
    `INSERT INTO admin_accounts
      (id, name, nickname, email, password_hash, avatar_data_url, auto_lock,
       settings_json, is_current, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  database.exec("BEGIN IMMEDIATE");
  try {
    insertSubject.run("unknown", "visitor", "SYSTEM-UNKNOWN");
    for (const person of bundle.snapshot.people) {
      insertSubject.run(person.id, person.type, person.barcode);
      insertPerson.run(person.id, JSON.stringify(person));
    }
    for (const asset of bundle.snapshot.hardwareAssets) {
      insertSubject.run(asset.id, "hardware", asset.barcode);
      insertHardware.run(asset.id, JSON.stringify(asset));
    }
    for (const checkpoint of bundle.snapshot.checkpoints) {
      insertCheckpoint.run(checkpoint.id, JSON.stringify(checkpoint));
    }
    for (const movement of bundle.snapshot.movements) {
      insertMovement.run(
        movement.id,
        movement.subjectId,
        movement.checkpointId,
        movement.createdAt ?? new Date(0).toISOString(),
        movement.denialCode ?? null,
        movement.result,
        movement.direction,
        movement.scanType ?? "manual",
        movement.subjectType,
        movement.syncState,
        JSON.stringify(movement)
      );
    }
    for (const alert of bundle.snapshot.alerts) {
      insertAlert.run(
        alert.id,
        alert.sourceEventId ?? null,
        alert.createdAt ?? new Date(0).toISOString(),
        JSON.stringify(alert)
      );
    }
    for (const permission of bundle.snapshot.permissions) {
      insertPermission.run(permission.id, permission.subjectId, JSON.stringify(permission));
    }
    for (const request of bundle.snapshot.permissionRequests) {
      insertRequest.run(
        request.id,
        request.subjectId,
        request.createdAt,
        JSON.stringify(request)
      );
    }
    for (const notification of bundle.snapshot.notifications) {
      insertNotification.run(
        notification.id,
        notification.createdAt,
        JSON.stringify(notification)
      );
    }
    for (const rule of bundle.snapshot.alertRules) {
      insertRule.run(rule.id, JSON.stringify(rule));
    }
    for (const audit of bundle.snapshot.auditEvents) {
      insertAudit.run(audit.id, audit.createdAt, JSON.stringify(audit));
    }
    bundle.admins.forEach((admin, index) => {
      insertAdmin.run(
        admin.id,
        admin.name,
        admin.nickname,
        admin.email,
        hashPassword(admin.password, `inout-seed-${admin.id}`),
        admin.avatarDataUrl,
        admin.autoLock,
        JSON.stringify(admin.settings),
        index === 0 ? 1 : 0,
        admin.createdAt
      );
    });
    database
      .prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)")
      .run("schema_version", SCHEMA_VERSION);
    database
      .prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)")
      .run("seed_anchor", bundle.anchor);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function migrateSchema(database: DatabaseSync, currentVersion?: string) {
  if (currentVersion !== "3") return false;
  const columns = database
    .prepare("PRAGMA table_info(movements)")
    .all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  const additions = [
    ["result", "TEXT"],
    ["direction", "TEXT"],
    ["scan_type", "TEXT"],
    ["subject_type", "TEXT"],
    ["sync_state", "TEXT"],
  ] as const;

  database.exec("BEGIN IMMEDIATE");
  try {
    for (const [name, type] of additions) {
      if (!names.has(name)) {
        database.exec(`ALTER TABLE movements ADD COLUMN ${name} ${type}`);
      }
    }
    database.exec(`
      UPDATE movements
      SET
        result = COALESCE(result, json_extract(data, '$.result')),
        direction = COALESCE(direction, json_extract(data, '$.direction')),
        scan_type = COALESCE(scan_type, json_extract(data, '$.scanType'), 'manual'),
        subject_type = COALESCE(subject_type, json_extract(data, '$.subjectType')),
        sync_state = COALESCE(sync_state, json_extract(data, '$.syncState'), 'synced');
      CREATE INDEX IF NOT EXISTS idx_movements_filters
        ON movements(result, direction, scan_type, subject_type, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_movements_sync_state
        ON movements(sync_state, occurred_at DESC);
      INSERT INTO app_metadata (key, value)
      VALUES ('schema_version', '${SCHEMA_VERSION}')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
      COMMIT;
    `);
    return true;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function ensureMovementIndexes(database: DatabaseSync) {
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_movements_filters
      ON movements(result, direction, scan_type, subject_type, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_movements_sync_state
      ON movements(sync_state, occurred_at DESC);
  `);
}

export function openDatabase(filename: string, anchor = new Date()) {
  if (filename !== ":memory:") {
    mkdirSync(path.dirname(filename), { recursive: true });
  }
  const database = new DatabaseSync(filename);
  createSchema(database);
  const metadata = database
    .prepare("SELECT value FROM app_metadata WHERE key = ?")
    .get("schema_version") as { value?: string } | undefined;
  if (
    metadata?.value !== SCHEMA_VERSION &&
    !migrateSchema(database, metadata?.value)
  ) {
    resetSchema(database);
    seedDatabase(database, buildSeedData(anchor));
  } else {
    const subjectCount = database
      .prepare("SELECT COUNT(*) AS count FROM subjects")
      .get() as { count: number };
    if (Number(subjectCount.count) === 0) {
      seedDatabase(database, buildSeedData(anchor));
    }
  }
  ensureMovementIndexes(database);
  return database;
}

export function getDatabase() {
  const shared = globalThis as GlobalDatabase;
  if (!shared.__inOutDatabase) {
    const filename =
      process.env.INOUT_DB_PATH ?? path.join(process.cwd(), ".data", "inout.sqlite");
    shared.__inOutDatabase = openDatabase(filename);
  }
  return shared.__inOutDatabase;
}

export function closeDatabaseForTests() {
  const shared = globalThis as GlobalDatabase;
  shared.__inOutDatabase?.close();
  delete shared.__inOutDatabase;
}
