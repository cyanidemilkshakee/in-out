import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { denialCodeForReason, evaluateScan } from "../lib/movementLogic";
import { startOfFacilityDay } from "../lib/dateRanges";
import {
  buildWorkdayStatuses,
  createScanAlert,
  evaluateScheduledRules,
} from "../lib/ruleEngine";
import type {
  AccessPermission,
  AccessPermissionMutationResult,
  Alert,
  AlertRule,
  AuditEvent,
  Checkpoint,
  HardwareAsset,
  MovementEvent,
  MovementPage,
  MovementQuery,
  Person,
  PermissionDecisionMutationResult,
  PermissionNotification,
  PermissionRequest,
  ScanAnalytics,
} from "../lib/types";
import type {
  AppDataSnapshot,
  CreateEmployeeInput,
  CreateHardwareAssetInput,
  CreateTemporaryVisitorInput,
  DataScope,
  MovementNotes,
  RecordScanInput,
  RecordScanResult,
  UpdateAccessPermissionInput,
} from "../lib/types";
import { getDatabase, withTransaction } from "./database";
import type { TimingSink } from "./timing";

type Queryable = Pick<Pool | PoolClient, "query">;
type JsonRow<T> = { data: T };
type NoteRow = { event_id: string; note: string };

const FACILITY_TIME_ZONE = "Asia/Kolkata";
const scheduledRuleRuns = new WeakMap<object, number>();

const EMPTY_ANALYTICS = {
  totalScans: 0,
  totalApproved: 0,
  totalDenied: 0,
  totalEntries: 0,
  totalExits: 0,
  totalAutomatic: 0,
  totalManual: 0,
  totalRestricted: 0,
  totalExpired: 0,
  totalOtherDenied: 0,
  activeInside: 0,
};

async function queryJsonRows<T>(
  database: Queryable,
  sql: string,
  params: unknown[] = [],
  timing?: TimingSink
) {
  const queryStartedAt = performance.now();
  const result = await database.query<JsonRow<T>>(sql, params);
  timing?.("db_query", performance.now() - queryStartedAt);
  return result.rows.map((row) => row.data);
}

async function jsonRow<T>(
  database: Queryable,
  sql: string,
  ...params: unknown[]
) {
  const result = await database.query<JsonRow<T>>(sql, params);
  return result.rows[0]?.data;
}

async function updateJson(
  database: Queryable,
  table: string,
  idColumn: string,
  id: string,
  value: unknown
) {
  const allowed = new Set([
    "people:subject_id",
    "hardware_assets:subject_id",
    "alerts:id",
    "access_permissions:id",
    "permission_requests:id",
    "alert_rules:id",
    "notifications:id",
  ]);
  if (!allowed.has(`${table}:${idColumn}`)) {
    throw new Error(`Unsupported JSON update target: ${table}.${idColumn}`);
  }
  await database.query(
    `UPDATE ${table} SET data = $1::jsonb WHERE ${idColumn} = $2`,
    [JSON.stringify(value), id]
  );
}

function facilityDate(date = new Date()) {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: FACILITY_TIME_ZONE,
  });
}

function facilityTime(date = new Date()) {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZone: FACILITY_TIME_ZONE,
  });
}

function makeId(prefix: string) {
  return `${prefix}-${randomUUID()}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function getPeople(database: Queryable, timing?: TimingSink) {
  return queryJsonRows<Person>(
    database,
    "SELECT data FROM people ORDER BY subject_id",
    [],
    timing
  );
}

function getHardware(database: Queryable, timing?: TimingSink) {
  return queryJsonRows<HardwareAsset>(
    database,
    "SELECT data FROM hardware_assets ORDER BY subject_id",
    [],
    timing
  );
}

function getCheckpoints(database: Queryable, timing?: TimingSink) {
  return queryJsonRows<Checkpoint>(
    database,
    "SELECT data FROM checkpoints ORDER BY id",
    [],
    timing
  );
}

function getMovements(
  database: Queryable,
  limit?: number,
  timing?: TimingSink
) {
  return queryJsonRows<MovementEvent>(
    database,
    `SELECT data FROM movements ORDER BY occurred_at DESC${limit ? " LIMIT $1" : ""}`,
    limit ? [limit] : [],
    timing
  );
}

function getAlerts(database: Queryable, limit?: number, timing?: TimingSink) {
  return queryJsonRows<Alert>(
    database,
    `SELECT data FROM alerts ORDER BY created_at DESC${limit ? " LIMIT $1" : ""}`,
    limit ? [limit] : [],
    timing
  );
}

function getPermissions(database: Queryable, timing?: TimingSink) {
  return queryJsonRows<AccessPermission>(
    database,
    "SELECT data FROM access_permissions ORDER BY id",
    [],
    timing
  );
}

function getPermissionRequests(database: Queryable, timing?: TimingSink) {
  return queryJsonRows<PermissionRequest>(
    database,
    "SELECT data FROM permission_requests ORDER BY created_at DESC",
    [],
    timing
  );
}

function getNotifications(database: Queryable, timing?: TimingSink) {
  return queryJsonRows<PermissionNotification>(
    database,
    "SELECT data FROM notifications ORDER BY created_at DESC",
    [],
    timing
  );
}

function getAlertRules(database: Queryable, timing?: TimingSink) {
  return queryJsonRows<AlertRule>(
    database,
    "SELECT data FROM alert_rules ORDER BY id",
    [],
    timing
  );
}

function getAuditEvents(
  database: Queryable,
  limit?: number,
  timing?: TimingSink
) {
  return queryJsonRows<AuditEvent>(
    database,
    `SELECT data FROM audit_events ORDER BY created_at DESC${limit ? " LIMIT $1" : ""}`,
    limit ? [limit] : [],
    timing
  );
}

async function getMovementNotes(
  database: Queryable,
  eventIds: string[],
  timing?: TimingSink
): Promise<MovementNotes> {
  if (eventIds.length === 0) return {};
  const startedAt = performance.now();
  const result = await database.query<NoteRow>(
    `SELECT event_id, note
     FROM movement_notes
     WHERE event_id = ANY($1::text[])
     ORDER BY id`,
    [eventIds]
  );
  timing?.("db_query", performance.now() - startedAt);
  const notes: MovementNotes = {};
  for (const row of result.rows) {
    notes[row.event_id] = [...(notes[row.event_id] ?? []), row.note];
  }
  return notes;
}

function hasScope(scope: DataScope, ...targets: DataScope[]) {
  return scope === "all" || targets.includes(scope);
}

function movementLimitForScope(scope: DataScope) {
  if (scope === "terminal") return 200;
  if (scope === "logs") return 25;
  if (scope === "dashboard") return 500;
  if (scope === "registry") return 1_000;
  return undefined;
}

function recordLimitForScope(scope: DataScope) {
  if (scope === "dashboard") return 500;
  if (scope === "logs" || scope === "alerts") return 2_000;
  if (scope === "registry" || scope === "permissions") return 2_000;
  return undefined;
}

async function getScanAnalytics(
  database: Queryable,
  timing?: TimingSink
): Promise<ScanAnalytics> {
  const startedAt = performance.now();
  const [movementResult, insideResult] = await Promise.all([
    database.query<Record<string, string>>(
      `SELECT
         count(*) AS "totalScans",
         count(*) FILTER (WHERE result = 'approved') AS "totalApproved",
         count(*) FILTER (WHERE result = 'denied') AS "totalDenied",
         count(*) FILTER (
           WHERE result = 'approved' AND direction = 'entry'
         ) AS "totalEntries",
         count(*) FILTER (
           WHERE result = 'approved' AND direction = 'exit'
         ) AS "totalExits",
         count(*) FILTER (WHERE scan_type = 'auto') AS "totalAutomatic",
         count(*) FILTER (WHERE scan_type = 'manual') AS "totalManual",
         count(*) FILTER (
           WHERE result = 'denied'
             AND denial_code IN (
               'asset_restricted',
               'access_restricted',
               'hardware_restricted',
               'zone_not_permitted'
             )
         ) AS "totalRestricted",
         count(*) FILTER (
           WHERE result = 'denied' AND denial_code = 'expired_pass'
         ) AS "totalExpired"
       FROM movements`
    ),
    database.query<{ activeInside: string }>(
      `SELECT count(*) AS "activeInside"
       FROM people
       WHERE data ->> 'inside' = 'true'`
    ),
  ]);
  timing?.("db_aggregate", performance.now() - startedAt);

  const row = movementResult.rows[0] ?? {};
  const insideRow = insideResult.rows[0] ?? { activeInside: "0" };
  const totalDenied = Number(row.totalDenied ?? 0);
  const totalRestricted = Number(row.totalRestricted ?? 0);
  const totalExpired = Number(row.totalExpired ?? 0);
  return {
    totalScans: Number(row.totalScans ?? 0),
    totalApproved: Number(row.totalApproved ?? 0),
    totalDenied,
    totalEntries: Number(row.totalEntries ?? 0),
    totalExits: Number(row.totalExits ?? 0),
    totalAutomatic: Number(row.totalAutomatic ?? 0),
    totalManual: Number(row.totalManual ?? 0),
    totalRestricted,
    totalExpired,
    totalOtherDenied: Math.max(
      0,
      totalDenied - totalRestricted - totalExpired
    ),
    activeInside: Number(insideRow.activeInside ?? 0),
  };
}

export async function getSnapshot(
  scope: DataScope = "all",
  timing?: TimingSink
): Promise<AppDataSnapshot> {
  const database = await getDatabase();
  if (hasScope(scope, "dashboard", "alerts")) {
    await evaluateAndPersistScheduledRules(database, false, timing);
  }
  const includePeople = hasScope(scope, "terminal", "registry", "permissions");
  const includeHardware = hasScope(scope, "terminal", "registry", "permissions");
  const includeMovements = hasScope(scope, "dashboard", "logs", "registry", "terminal");
  const includeAlerts = hasScope(scope, "dashboard", "logs", "registry", "alerts");
  const initialMovementPagePromise =
    scope === "logs"
      ? queryMovementPage(
          database,
          {
            page: 1,
            pageSize: 25,
            subjectGroup: "people",
            startAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
            endAt: new Date().toISOString(),
            sortKey: "createdAt",
            sortDirection: "desc",
          },
          timing
        )
      : undefined;
  const dashboardMovementPagePromise =
    scope === "dashboard"
      ? queryMovementPage(
          database,
          {
            page: 1,
            pageSize: 100,
            startAt: new Date(startOfFacilityDay()).toISOString(),
            endAt: new Date().toISOString(),
            sortKey: "createdAt",
            sortDirection: "desc",
          },
          timing
        )
      : Promise.resolve(undefined);
  const recordLimit = recordLimitForScope(scope);
  const [
    people,
    hardwareAssets,
    checkpoints,
    initialMovementPage,
    dashboardMovementPage,
    scopedMovements,
    alerts,
    scanAnalytics,
    permissions,
    permissionRequests,
    notifications,
    alertRules,
    auditEvents,
  ] = await Promise.all([
    includePeople ? getPeople(database, timing) : Promise.resolve([]),
    includeHardware ? getHardware(database, timing) : Promise.resolve([]),
    hasScope(scope, "terminal")
      ? getCheckpoints(database, timing)
      : Promise.resolve([]),
    initialMovementPagePromise,
    dashboardMovementPagePromise,
    includeMovements && scope !== "logs" && scope !== "dashboard"
      ? getMovements(database, movementLimitForScope(scope), timing)
      : Promise.resolve([]),
    includeAlerts
      ? getAlerts(database, recordLimit, timing)
      : Promise.resolve([]),
    hasScope(scope, "dashboard", "terminal")
      ? getScanAnalytics(database, timing)
      : Promise.resolve(EMPTY_ANALYTICS),
    hasScope(scope, "permissions")
      ? getPermissions(database, timing)
      : Promise.resolve([]),
    hasScope(scope, "permissions")
      ? getPermissionRequests(database, timing)
      : Promise.resolve([]),
    hasScope(scope, "permissions")
      ? getNotifications(database, timing)
      : Promise.resolve([]),
    hasScope(scope, "alerts")
      ? getAlertRules(database, timing)
      : Promise.resolve([]),
    hasScope(scope, "logs", "registry", "permissions")
      ? getAuditEvents(database, recordLimit, timing)
      : Promise.resolve([]),
  ]);
  const movements =
    initialMovementPage?.items ??
    dashboardMovementPage?.chartItems ??
    scopedMovements;

  return {
    people,
    hardwareAssets,
    checkpoints,
    movements,
    movementPage: initialMovementPage,
    alerts,
    scanAnalytics,
    movementNotes: initialMovementPage
      ? initialMovementPage.movementNotes
      : hasScope(scope, "logs")
      ? await getMovementNotes(
          database,
          movements.map((movement) => movement.id),
          timing
        )
      : {},
    permissions,
    permissionRequests,
    notifications,
    alertRules,
    auditEvents,
  };
}

const MOVEMENT_SORT_COLUMNS: Record<
  NonNullable<MovementQuery["sortKey"]>,
  string
> = {
  date: "occurred_at",
  time: "occurred_at",
  createdAt: "occurred_at",
  name: "data ->> 'subjectName'",
  type: "subject_type",
  direction: "direction",
  checkpoint: "data ->> 'checkpoint'",
  result: "result",
  barcode: "data ->> 'barcode'",
  scanType: "scan_type",
  eventId: "id",
};

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

async function queryMovementPage(
  database: Queryable,
  query: MovementQuery,
  timing?: TimingSink
): Promise<MovementPage> {
  const page = Math.max(1, Math.floor(query.page || 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize || 25)));
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.startAt) {
    params.push(query.startAt);
    where.push(`occurred_at >= $${params.length}`);
  }
  if (query.endAt) {
    params.push(query.endAt);
    where.push(`occurred_at <= $${params.length}`);
  }
  if (query.checkpoint) {
    params.push(query.checkpoint);
    where.push(`data ->> 'checkpoint' = $${params.length}`);
  }
  if (query.result) {
    params.push(query.result);
    where.push(`result = $${params.length}`);
  }
  if (query.scanType) {
    params.push(query.scanType);
    where.push(`scan_type = $${params.length}`);
  }
  if (query.direction) {
    params.push(query.direction);
    where.push(`direction = $${params.length}`);
  }
  if (query.subjectGroup === "hardware") {
    where.push("subject_type = 'hardware'");
  } else if (query.subjectGroup === "people") {
    where.push("subject_type IN ('employee', 'visitor')");
  }
  const search = query.search?.trim().toLowerCase();
  if (search) {
    const needle = `%${escapeLike(search)}%`;
    params.push(needle);
    const searchParameter = `$${params.length}`;
    where.push(
      `(
        data ->> 'subjectName' ILIKE ${searchParameter} ESCAPE E'\\\\'
        OR data ->> 'barcode' ILIKE ${searchParameter} ESCAPE E'\\\\'
        OR data ->> 'checkpoint' ILIKE ${searchParameter} ESCAPE E'\\\\'
        OR COALESCE(data ->> 'reason', '') ILIKE ${searchParameter} ESCAPE E'\\\\'
      )`
    );
  }

  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const sortColumn =
    MOVEMENT_SORT_COLUMNS[query.sortKey ?? "createdAt"] ?? "occurred_at";
  const sortDirection = query.sortDirection === "asc" ? "ASC" : "DESC";
  const queryStartedAt = performance.now();
  const countResult = await database.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM movements${whereSql}`,
    params
  );
  timing?.("db_query", performance.now() - queryStartedAt);

  const itemParams = [...params, pageSize, (page - 1) * pageSize];
  const items = await queryJsonRows<MovementEvent>(
    database,
    `SELECT data
     FROM movements${whereSql}
     ORDER BY ${sortColumn} ${sortDirection}, occurred_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    itemParams,
    timing
  );
  const chartItems = await queryJsonRows<MovementEvent>(
    database,
    `SELECT data
     FROM movements${whereSql}
     ORDER BY occurred_at DESC
     LIMIT 2000`,
    params,
    timing
  );
  const checkpointStartedAt = performance.now();
  const checkpointResult = await database.query<{ checkpoint: string }>(
    `SELECT DISTINCT data ->> 'checkpoint' AS checkpoint
     FROM movements
     WHERE data ? 'checkpoint'
     ORDER BY checkpoint`
  );
  timing?.("db_query", performance.now() - checkpointStartedAt);

  return {
    items,
    chartItems,
    movementNotes: await getMovementNotes(
      database,
      items.map((movement) => movement.id),
      timing
    ),
    total: Number(countResult.rows[0]?.count ?? 0),
    page,
    pageSize,
    checkpoints: checkpointResult.rows.map((row) => row.checkpoint),
  };
}

export async function queryMovements(
  query: MovementQuery,
  timing?: TimingSink
) {
  return queryMovementPage(await getDatabase(), query, timing);
}

async function assertBarcodeAvailable(
  database: Queryable,
  barcode: string,
  exceptId?: string
) {
  const result = await database.query<{ id: string }>(
    "SELECT id FROM subjects WHERE lower(barcode) = lower($1)",
    [barcode]
  );
  const existing = result.rows[0];
  if (existing && existing.id !== exceptId) {
    throw new Error(`Barcode ${barcode} is already assigned.`);
  }
}

async function insertPermission(
  database: Queryable,
  permission: AccessPermission
) {
  await database.query(
    `INSERT INTO access_permissions (id, subject_id, data)
     VALUES ($1, $2, $3::jsonb)`,
    [permission.id, permission.subjectId, JSON.stringify(permission)]
  );
}

async function insertNotification(
  database: Queryable,
  notification: PermissionNotification
) {
  await database.query(
    `INSERT INTO notifications (id, created_at, data)
     VALUES ($1, $2, $3::jsonb)`,
    [
      notification.id,
      notification.createdAt,
      JSON.stringify(notification),
    ]
  );
}

async function insertAudit(database: Queryable, audit: AuditEvent) {
  await database.query(
    `INSERT INTO audit_events (id, created_at, data)
     VALUES ($1, $2, $3::jsonb)`,
    [audit.id, audit.createdAt, JSON.stringify(audit)]
  );
}

async function evaluateAndPersistScheduledRules(
  database: Queryable,
  force: boolean,
  timing?: TimingSink
) {
  const now = new Date();
  const lastRun = scheduledRuleRuns.get(database as object) ?? 0;
  if (!force && now.getTime() - lastRun < 60_000) return [] as Alert[];
  scheduledRuleRuns.set(database as object, now.getTime());

  const since = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
  const rules = await queryJsonRows<AlertRule>(
    database,
    `SELECT data
     FROM alert_rules
     WHERE data ->> 'enabled' = 'true'
       AND data ->> 'conditionKey' IN ('exit_balance', 'no_break')`,
    [],
    timing
  );
  if (rules.length === 0) return [] as Alert[];

  const movements = await queryJsonRows<MovementEvent>(
    database,
    `SELECT data
     FROM movements
     WHERE occurred_at >= $1
     ORDER BY occurred_at`,
    [since],
    timing
  );
  const people = await queryJsonRows<Person>(
    database,
    `SELECT data
     FROM people
     WHERE data ->> 'type' = 'employee'`,
    [],
    timing
  );
  const existingAlerts = await queryJsonRows<Alert>(
    database,
    `SELECT data
     FROM alerts
     WHERE created_at >= $1
       AND data ? 'ruleId'`,
    [since],
    timing
  );
  const ruleStartedAt = performance.now();
  const candidates = evaluateScheduledRules({
    rules,
    movements,
    workdays: buildWorkdayStatuses(movements, people),
    existingAlerts,
  });
  timing?.("rule_evaluation", performance.now() - ruleStartedAt);
  if (candidates.length === 0) return [] as Alert[];

  return withTransaction(async (transaction) => {
    const alerts: Alert[] = [];
    for (const candidate of candidates) {
      const createdAt = candidate.createdAt ?? now.toISOString();
      const alert: Alert = {
        ...candidate,
        id: makeId("AL"),
        createdAt,
      };
      await transaction.query(
        `INSERT INTO alerts (id, source_event_id, created_at, data)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          alert.id,
          alert.sourceEventId ?? null,
          createdAt,
          JSON.stringify(alert),
        ]
      );
      await insertAudit(transaction, {
        id: makeId("AUD"),
        category: "alert",
        action: "Scheduled alert raised",
        subjectId: alert.barcode,
        subjectName: alert.subjectName,
        actor: "Rule Engine",
        role: "System",
        reason: alert.reason,
        relatedId: alert.id,
        date: alert.date,
        time: alert.time,
        createdAt,
      });
      alerts.push(clone(alert));
    }
    return alerts;
  });
}

export async function createTemporaryVisitor(input: CreateTemporaryVisitorInput) {
  const database = await getDatabase();
  const barcode = input.barcode.trim().toUpperCase();
  if (!barcode) throw new Error("Visitor barcode is required.");
  await assertBarcodeAvailable(database, barcode);
  const now = new Date();
  const requestedStart = new Date(input.validFrom);
  const requestedEnd = new Date(input.validUntil);
  const start =
    Number.isNaN(requestedStart.getTime()) || requestedStart < now
      ? now
      : requestedStart;
  const maximumEnd = start.getTime() + 24 * 60 * 60 * 1000;
  const fallbackEnd =
    start.getTime() + Math.min(24, Math.max(1, input.hours)) * 60 * 60 * 1000;
  const end = new Date(
    Number.isNaN(requestedEnd.getTime()) || requestedEnd <= start
      ? fallbackEnd
      : Math.min(requestedEnd.getTime(), maximumEnd)
  );
  const id = makeId("vis");
  const visitor: Person = {
    id,
    name: input.name.trim() || "Temporary Visitor",
    type: "visitor",
    barcode,
    company: input.company.trim() || "Walk-in",
    phone: "Not provided",
    accessLevel: "Visitor",
    allowedZones: ["Main Entrance"],
    status: "pending_approval",
    host: input.host.trim() || "Security Desk",
    purpose: input.reason.trim() || "Temporary visit",
    validFrom: start.toISOString(),
    validTo: end.toISOString(),
    inside: false,
    createdAt: now.toISOString(),
  };
  const request: PermissionRequest = {
    id: makeId("REQ-VIS"),
    type: "visitor",
    subjectId: visitor.id,
    subjectName: visitor.name,
    requester: visitor.host ?? "Security Desk",
    purpose: visitor.purpose ?? "Temporary visit",
    requestedZones: [...visitor.allowedZones],
    validFrom: visitor.validFrom ?? now.toISOString(),
    validTo: visitor.validTo ?? end.toISOString(),
    status: "pending",
    createdAt: now.toISOString(),
  };
  const permission: AccessPermission = {
    id: `perm-${visitor.id}`,
    subjectId: visitor.id,
    subjectName: visitor.name,
    subjectType: "visitor",
    assignment: "Visitor access",
    state: "pending_approval",
    zones: [...visitor.allowedZones],
    validFrom: visitor.validFrom ?? now.toISOString(),
    validTo: visitor.validTo ?? end.toISOString(),
    source: "request",
    reason: "Awaiting permission manager approval",
    updatedAt: now.toISOString(),
    updatedBy: "Security Terminal",
  };
  const notification: PermissionNotification = {
    id: makeId("NOT"),
    title: "Visitor approval requested",
    message: `${visitor.name} was created at the security terminal and needs access approval.`,
    category: "approval_request",
    priority: "high",
    relatedId: request.id,
    href: `/admin/permissions?request=${request.id}`,
    createdAt: now.toISOString(),
    read: false,
  };

  return withTransaction(async (transaction) => {
    await transaction.query(
      "INSERT INTO subjects (id, kind, barcode) VALUES ($1, $2, $3)",
      [visitor.id, visitor.type, visitor.barcode]
    );
    await transaction.query(
      "INSERT INTO people (subject_id, data) VALUES ($1, $2::jsonb)",
      [visitor.id, JSON.stringify(visitor)]
    );
    await transaction.query(
      `INSERT INTO permission_requests
        (id, subject_id, created_at, data) VALUES ($1, $2, $3, $4::jsonb)`,
      [request.id, request.subjectId, request.createdAt, JSON.stringify(request)]
    );
    await insertPermission(transaction, permission);
    await insertNotification(transaction, notification);
    return clone(visitor);
  });
}

export async function createEmployee(input: CreateEmployeeInput) {
  const database = await getDatabase();
  const barcode = input.barcode.trim().toUpperCase();
  if (!barcode || !input.name.trim()) {
    throw new Error("Employee name and barcode are required.");
  }
  await assertBarcodeAvailable(database, barcode);
  const now = new Date();
  const employee: Person = {
    id: makeId("emp"),
    name: input.name.trim(),
    type: "employee",
    barcode,
    department: input.department.trim(),
    phone: "Not provided",
    accessLevel: input.accessLevel,
    allowedZones: [input.allowedZone],
    status: "active",
    inside: false,
    createdAt: now.toISOString(),
  };
  const permission: AccessPermission = {
    id: `perm-${employee.id}`,
    subjectId: employee.id,
    subjectName: employee.name,
    subjectType: "employee",
    assignment: `${employee.department} employee`,
    state: "active",
    zones: [...employee.allowedZones],
    validFrom: now.toISOString(),
    validTo: "No expiry",
    source: "policy",
    updatedAt: now.toISOString(),
    updatedBy: "Admin User",
  };
  return withTransaction(async (transaction) => {
    await transaction.query(
      "INSERT INTO subjects (id, kind, barcode) VALUES ($1, $2, $3)",
      [employee.id, employee.type, employee.barcode]
    );
    await transaction.query(
      "INSERT INTO people (subject_id, data) VALUES ($1, $2::jsonb)",
      [employee.id, JSON.stringify(employee)]
    );
    await insertPermission(transaction, permission);
    return clone(employee);
  });
}

export async function createHardwareAsset(input: CreateHardwareAssetInput) {
  const database = await getDatabase();
  const barcode = input.barcode.trim().toUpperCase();
  if (!barcode || !input.name.trim()) {
    throw new Error("Hardware name and barcode are required.");
  }
  await assertBarcodeAvailable(database, barcode);
  const now = new Date();
  const people = await getPeople(database);
  const assignedEmployee = people.find(
    (person) =>
      person.type === "employee" &&
      person.name.toLowerCase() === input.owner.trim().toLowerCase()
  );
  const asset: HardwareAsset = {
    id: makeId("hw"),
    name: input.name.trim(),
    barcode,
    owner: input.owner.trim(),
    assignedEmployeeId: assignedEmployee?.id,
    assignedEmployeeName: assignedEmployee?.name,
    category: input.category.trim(),
    allowedZones: [input.allowedZone],
    status: input.status,
    inside: false,
    createdAt: now.toISOString(),
  };
  const permission: AccessPermission = {
    id: `perm-${asset.id}`,
    subjectId: asset.id,
    subjectName: asset.name,
    subjectType: "hardware",
    assignment: assignedEmployee
      ? `Assigned to ${assignedEmployee.name}`
      : asset.owner,
    state: asset.status === "restricted" ? "restricted" : "active",
    zones: [...asset.allowedZones],
    validFrom: now.toISOString(),
    validTo: "No expiry",
    source: "policy",
    updatedAt: now.toISOString(),
    updatedBy: "Asset Manager",
  };
  return withTransaction(async (transaction) => {
    await transaction.query(
      "INSERT INTO subjects (id, kind, barcode) VALUES ($1, 'hardware', $2)",
      [asset.id, asset.barcode]
    );
    await transaction.query(
      "INSERT INTO hardware_assets (subject_id, data) VALUES ($1, $2::jsonb)",
      [asset.id, JSON.stringify(asset)]
    );
    await insertPermission(transaction, permission);
    return clone(asset);
  });
}

export async function updatePerson(
  personId: string,
  patch: Partial<Omit<Person, "id">>
) {
  const database = await getDatabase();
  const existing = await jsonRow<Person>(
    database,
    "SELECT data FROM people WHERE subject_id = $1",
    personId
  );
  if (!existing) throw new Error(`Person ${personId} was not found.`);
  const barcode =
    typeof patch.barcode === "string"
      ? patch.barcode.trim().toUpperCase()
      : existing.barcode;
  await assertBarcodeAvailable(database, barcode, personId);
  const updated: Person = { ...existing, ...patch, id: existing.id, barcode };
  return withTransaction(async (transaction) => {
    await updateJson(transaction, "people", "subject_id", personId, updated);
    await transaction.query("UPDATE subjects SET barcode = $1 WHERE id = $2", [
      updated.barcode,
      personId,
    ]);
    return clone(updated);
  });
}

export async function updateHardwareAsset(
  assetId: string,
  patch: Partial<Omit<HardwareAsset, "id">>
) {
  const database = await getDatabase();
  const existing = await jsonRow<HardwareAsset>(
    database,
    "SELECT data FROM hardware_assets WHERE subject_id = $1",
    assetId
  );
  if (!existing) throw new Error(`Hardware asset ${assetId} was not found.`);
  const barcode =
    typeof patch.barcode === "string"
      ? patch.barcode.trim().toUpperCase()
      : existing.barcode;
  await assertBarcodeAvailable(database, barcode, assetId);
  const updated: HardwareAsset = { ...existing, ...patch, id: existing.id, barcode };
  return withTransaction(async (transaction) => {
    await updateJson(
      transaction,
      "hardware_assets",
      "subject_id",
      assetId,
      updated
    );
    await transaction.query("UPDATE subjects SET barcode = $1 WHERE id = $2", [
      updated.barcode,
      assetId,
    ]);
    return clone(updated);
  });
}

export async function updateAlert(
  alertId: string,
  patch: Partial<Omit<Alert, "id">>
) {
  const database = await getDatabase();
  const existing = await jsonRow<Alert>(
    database,
    "SELECT data FROM alerts WHERE id = $1",
    alertId
  );
  if (!existing) throw new Error(`Alert ${alertId} was not found.`);
  const updated: Alert = { ...existing, ...patch, id: existing.id };
  await updateJson(database, "alerts", "id", alertId, updated);
  return clone(updated);
}

export async function updateAccessPermission(
  input: UpdateAccessPermissionInput
): Promise<AccessPermissionMutationResult> {
  const database = await getDatabase();
  const existing = await jsonRow<AccessPermission>(
    database,
    "SELECT data FROM access_permissions WHERE subject_id = $1",
    input.subjectId
  );
  if (!existing) throw new Error(`Permission for ${input.subjectId} was not found.`);
  const now = new Date();
  const updated: AccessPermission = {
    ...existing,
    state: input.state,
    zones: input.zones?.length ? [...input.zones] : [...existing.zones],
    validFrom: input.validFrom || existing.validFrom,
    validTo: input.validTo || existing.validTo,
    source: "manual",
    reason: input.reason.trim(),
    updatedAt: now.toISOString(),
    updatedBy: "Admin User",
  };
  const audit: AuditEvent = {
    id: makeId("AUD"),
    category: "permission",
    action:
      input.state === "active"
        ? "Manual permission granted"
        : "Manual permission changed",
    subjectId: updated.subjectId,
    subjectName: updated.subjectName,
    actor: "Admin User",
    role: "Administrator",
    decision: input.state === "active" ? "granted" : "denied",
    reason: input.reason,
    relatedId: updated.id,
    date: facilityDate(now),
    time: facilityTime(now),
    createdAt: now.toISOString(),
  };
  const notification: PermissionNotification = {
    id: makeId("NOT"),
    title: input.state === "active" ? "Permission granted" : "Permission changed",
    message: `${updated.subjectName}: ${input.reason}`,
    category: "permission_change",
    priority: input.state === "active" ? "normal" : "high",
    relatedId: updated.id,
    href: `/admin/permissions?subject=${updated.subjectId}`,
    createdAt: now.toISOString(),
    read: false,
  };

  return withTransaction(async (transaction) => {
    await updateJson(
      transaction,
      "access_permissions",
      "id",
      updated.id,
      updated
    );
    let updatedPerson: Person | undefined;
    const person = await jsonRow<Person>(
      transaction,
      "SELECT data FROM people WHERE subject_id = $1",
      input.subjectId
    );
    if (person) {
      const status: Person["status"] =
        input.state === "active"
          ? person.type === "visitor"
            ? "pre_approved"
            : "active"
          : input.state === "restricted"
            ? "restricted"
            : input.state === "expired"
              ? "expired"
              : input.state === "pending_approval"
                ? "pending_approval"
                : "inactive";
      updatedPerson = {
        ...person,
        status,
        allowedZones: [...updated.zones],
      };
      await updateJson(
        transaction,
        "people",
        "subject_id",
        person.id,
        updatedPerson
      );
    }
    let updatedHardwareAsset: HardwareAsset | undefined;
    const hardware = await jsonRow<HardwareAsset>(
      transaction,
      "SELECT data FROM hardware_assets WHERE subject_id = $1",
      input.subjectId
    );
    if (hardware) {
      updatedHardwareAsset = {
        ...hardware,
        status:
          input.state === "restricted" || input.state === "revoked"
            ? "restricted"
            : "active",
        allowedZones: [...updated.zones],
      };
      await updateJson(
        transaction,
        "hardware_assets",
        "subject_id",
        hardware.id,
        updatedHardwareAsset
      );
    }
    await insertAudit(transaction, audit);
    await insertNotification(transaction, notification);
    return clone({
      permission: updated,
      person: updatedPerson,
      hardwareAsset: updatedHardwareAsset,
      auditEvent: audit,
      notification,
    });
  });
}

export async function decidePermissionRequest(
  requestId: string,
  decision: "approved" | "denied",
  reason: string
): Promise<PermissionDecisionMutationResult> {
  const database = await getDatabase();
  const existing = await jsonRow<PermissionRequest>(
    database,
    "SELECT data FROM permission_requests WHERE id = $1",
    requestId
  );
  if (!existing) throw new Error(`Permission request ${requestId} was not found.`);
  if (existing.status !== "pending") {
    return { request: clone(existing) };
  }
  const now = new Date();
  const updated: PermissionRequest = { ...existing, status: decision };
  const audit: AuditEvent = {
    id: makeId("AUD"),
    category: "permission",
    action: `${existing.type === "visitor" ? "Visitor" : "Hardware custody"} request ${decision}`,
    subjectId: existing.subjectId,
    subjectName: existing.subjectName,
    actor: "Admin User",
    role: "Administrator",
    decision: decision === "approved" ? "granted" : "denied",
    reason,
    relatedId: requestId,
    date: facilityDate(now),
    time: facilityTime(now),
    createdAt: now.toISOString(),
  };
  const notification: PermissionNotification = {
    id: makeId("NOT"),
    title: `Request ${decision}`,
    message: `${existing.subjectName}: ${reason}`,
    category: "permission_change",
    priority: decision === "denied" ? "high" : "normal",
    relatedId: requestId,
    href: `/admin/permissions?request=${requestId}`,
    createdAt: now.toISOString(),
    read: false,
  };

  return withTransaction(async (transaction) => {
    await updateJson(
      transaction,
      "permission_requests",
      "id",
      requestId,
      updated
    );
    let updatedPerson: Person | undefined;
    if (existing.type === "visitor") {
      const person = await jsonRow<Person>(
        transaction,
        "SELECT data FROM people WHERE subject_id = $1",
        existing.subjectId
      );
      if (person) {
        updatedPerson = {
          ...person,
          status: decision === "approved" ? "pre_approved" : "inactive",
        };
        await updateJson(
          transaction,
          "people",
          "subject_id",
          person.id,
          updatedPerson
        );
      }
    }
    let updatedHardwareAsset: HardwareAsset | undefined;
    if (existing.type === "hardware_custody" && existing.hardwareId) {
      const asset = await jsonRow<HardwareAsset>(
        transaction,
        "SELECT data FROM hardware_assets WHERE subject_id = $1",
        existing.hardwareId
      );
      if (asset && decision === "approved") {
        updatedHardwareAsset = {
          ...asset,
          assignedEmployeeId: existing.carrierId,
          assignedEmployeeName: existing.carrierName,
        };
        await updateJson(
          transaction,
          "hardware_assets",
          "subject_id",
          asset.id,
          updatedHardwareAsset
        );
      }
    }
    const permission = await jsonRow<AccessPermission>(
      transaction,
      "SELECT data FROM access_permissions WHERE subject_id = $1",
      existing.subjectId
    );
    const updatedPermission = permission
      ? {
          ...permission,
          state: decision === "approved" ? "active" : "revoked",
          source: "request",
          reason,
          updatedAt: now.toISOString(),
          updatedBy: "Admin User",
        } satisfies AccessPermission
      : undefined;
    if (updatedPermission) {
      await updateJson(
        transaction,
        "access_permissions",
        "id",
        updatedPermission.id,
        updatedPermission
      );
    }
    await insertAudit(transaction, audit);
    await insertNotification(transaction, notification);
    return clone({
      request: updated,
      permission: updatedPermission,
      person: updatedPerson,
      hardwareAsset: updatedHardwareAsset,
      auditEvent: audit,
      notification,
    });
  });
}

export async function updateAlertRule(ruleId: string, enabled: boolean) {
  const database = await getDatabase();
  const existing = await jsonRow<AlertRule>(
    database,
    "SELECT data FROM alert_rules WHERE id = $1",
    ruleId
  );
  if (!existing) throw new Error(`Alert rule ${ruleId} was not found.`);
  const updated = { ...existing, enabled };
  await updateJson(database, "alert_rules", "id", ruleId, updated);
  return clone(updated);
}

export async function markNotificationRead(notificationId: string) {
  const database = await getDatabase();
  const existing = await jsonRow<PermissionNotification>(
    database,
    "SELECT data FROM notifications WHERE id = $1",
    notificationId
  );
  if (!existing) {
    throw new Error(`Notification ${notificationId} was not found.`);
  }
  const updated = { ...existing, read: true };
  await updateJson(database, "notifications", "id", notificationId, updated);
  return clone(updated);
}

async function insertMovement(
  database: Queryable,
  movement: MovementEvent
) {
  await database.query(
    `INSERT INTO movements (
       id, subject_id, checkpoint_id, occurred_at, denial_code, result,
       direction, scan_type, subject_type, sync_state, data
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
    [
      movement.id,
      movement.subjectId,
      movement.checkpointId,
      movement.createdAt ?? new Date().toISOString(),
      movement.denialCode ?? null,
      movement.result,
      movement.direction,
      movement.scanType ?? "manual",
      movement.subjectType,
      movement.syncState,
      JSON.stringify(movement),
    ]
  );
}

function getSubjectByBarcode(database: Queryable, barcode: string) {
  return jsonRow<Person | HardwareAsset>(
    database,
    `SELECT COALESCE(people.data, hardware_assets.data) AS data
     FROM subjects
     LEFT JOIN people ON people.subject_id = subjects.id
     LEFT JOIN hardware_assets ON hardware_assets.subject_id = subjects.id
     WHERE lower(subjects.barcode) = lower($1)
     LIMIT 1`,
    barcode.trim()
  );
}

function getHardwareByIds(database: Queryable, assetIds: string[]) {
  const uniqueIds = [...new Set(assetIds)];
  if (uniqueIds.length === 0) return Promise.resolve([] as HardwareAsset[]);
  return queryJsonRows<HardwareAsset>(
    database,
    `SELECT data
     FROM hardware_assets
     WHERE subject_id = ANY($1::text[])`,
    [uniqueIds]
  );
}

export async function recordScan(
  input: RecordScanInput,
  timing?: TimingSink
): Promise<RecordScanResult> {
  const database = await getDatabase();
  const lookupStartedAt = performance.now();
  const [subject, checkpoint, selectedHardware, rules] = await Promise.all([
    getSubjectByBarcode(database, input.barcode),
    jsonRow<Checkpoint>(
      database,
      "SELECT data FROM checkpoints WHERE id = $1",
      input.checkpointId
    ),
    getHardwareByIds(database, input.selectedHardwareIds),
    getAlertRules(database, timing),
  ]);
  if (!checkpoint) {
    throw new Error(`Checkpoint ${input.checkpointId} was not found.`);
  }
  timing?.("scan_lookup", performance.now() - lookupStartedAt);

  const people =
    subject && "type" in subject ? [subject as Person] : ([] as Person[]);
  const hardwareById = new Map(
    selectedHardware.map((asset) => [asset.id, asset])
  );
  if (subject && !("type" in subject)) {
    hardwareById.set(subject.id, subject);
  }
  const hardware = [...hardwareById.values()];
  const decisionStartedAt = performance.now();
  const rawDecision = evaluateScan({
    barcode: input.barcode,
    checkpoint,
    people,
    hardware,
    selectedHardwareIds: input.selectedHardwareIds,
    online: input.online,
    eventCount: 0,
    scanType: input.scanType,
  });
  const now = new Date();
  const event: MovementEvent = {
    ...rawDecision.event,
    id: makeId("EVT"),
    createdAt: now.toISOString(),
    denialCode:
      rawDecision.event.result === "denied"
        ? denialCodeForReason(rawDecision.event.reason)
        : undefined,
  };
  const decision = { ...rawDecision, event };
  timing?.("scan_decision", performance.now() - decisionStartedAt);

  const updatedPeople: Person[] = [];
  const updatedHardwareAssets: HardwareAsset[] = [];
  if (event.result === "approved") {
    const inside = event.direction === "entry";
    if (subject && "type" in subject && subject.inside !== inside) {
      updatedPeople.push({ ...subject, inside });
    }
    for (const asset of hardware) {
      if (
        (asset.id === event.subjectId || event.hardwareIds.includes(asset.id)) &&
        asset.inside !== inside
      ) {
        updatedHardwareAssets.push({ ...asset, inside });
      }
    }
  }

  const ruleStartedAt = performance.now();
  let generatedAlert = createScanAlert({
    event,
    subject: decision.subject,
    carriedHardware: decision.carriedHardware,
    rules,
    existingAlerts: [],
    alertId: makeId("AL"),
  });
  if (generatedAlert?.ruleId) {
    const duplicate = await database.query<{ id: string }>(
      `SELECT id
       FROM alerts
       WHERE data ->> 'ruleId' = $1
         AND data ->> 'status' = 'open'
       LIMIT 1`,
      [generatedAlert.ruleId]
    );
    if (duplicate.rows[0]) generatedAlert = undefined;
  }
  timing?.("rule_evaluation", performance.now() - ruleStartedAt);

  const writeStartedAt = performance.now();
  const scanResult = await withTransaction(async (transaction) => {
    await insertMovement(transaction, event);
    for (const person of updatedPeople) {
      await updateJson(transaction, "people", "subject_id", person.id, person);
    }
    for (const asset of updatedHardwareAssets) {
      await updateJson(
        transaction,
        "hardware_assets",
        "subject_id",
        asset.id,
        asset
      );
    }
    if (generatedAlert) {
      await transaction.query(
        `INSERT INTO alerts (id, source_event_id, created_at, data)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          generatedAlert.id,
          generatedAlert.sourceEventId ?? null,
          generatedAlert.createdAt ?? now.toISOString(),
          JSON.stringify(generatedAlert),
        ]
      );
      await insertAudit(transaction, {
        id: makeId("AUD"),
        category: "alert",
        action: "Automated alert raised",
        subjectId: event.subjectId,
        subjectName: event.subjectName,
        actor: "Rule Engine",
        role: "System",
        reason: generatedAlert.reason,
        relatedId: generatedAlert.id,
        date: generatedAlert.date,
        time: generatedAlert.time,
        createdAt: now.toISOString(),
      });
    }

    const carrier =
      decision.subject && "type" in decision.subject
        ? decision.subject
        : undefined;
    const custodyAsset = decision.carriedHardware.find(
      (asset) =>
        carrier &&
        asset.assignedEmployeeId &&
        asset.assignedEmployeeId !== carrier.id
    );
    if (carrier && custodyAsset && event.denialCode === "custody_mismatch") {
      const duplicate = await transaction.query<{ id: string }>(
        `SELECT id FROM permission_requests
         WHERE data ->> 'type' = 'hardware_custody'
           AND data ->> 'hardwareId' = $1
           AND data ->> 'carrierId' = $2
           AND data ->> 'status' = 'pending'
         LIMIT 1`,
        [custodyAsset.id, carrier.id]
      );
      if (!duplicate.rows[0]) {
        const request: PermissionRequest = {
          id: makeId("REQ-HW"),
          type: "hardware_custody",
          subjectId: custodyAsset.id,
          subjectName: custodyAsset.name,
          requester: carrier.name,
          purpose: `Custody exception requested at ${event.checkpoint}`,
          requestedZones: [...custodyAsset.allowedZones],
          validFrom: event.createdAt ?? now.toISOString(),
          validTo: "End of day",
          status: "pending",
          createdAt: now.toISOString(),
          hardwareId: custodyAsset.id,
          carrierId: carrier.id,
          carrierName: carrier.name,
        };
        await transaction.query(
          `INSERT INTO permission_requests
            (id, subject_id, created_at, data)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [
            request.id,
            request.subjectId,
            request.createdAt,
            JSON.stringify(request),
          ]
        );
        await insertNotification(transaction, {
          id: makeId("NOT"),
          title: "Hardware custody approval requested",
          message: `${carrier.name} attempted to move ${custodyAsset.name}, assigned to ${custodyAsset.assignedEmployeeName}.`,
          category: "approval_request",
          priority: "high",
          relatedId: request.id,
          href: `/admin/permissions?request=${request.id}`,
          createdAt: now.toISOString(),
          read: false,
        });
      }
    }
    return {
      decision: clone(decision),
      updatedPeople: clone(updatedPeople),
      updatedHardwareAssets: clone(updatedHardwareAssets),
      generatedAlerts: generatedAlert ? [clone(generatedAlert)] : [],
    };
  });
  timing?.("scan_write", performance.now() - writeStartedAt);

  const scheduledAlerts = await evaluateAndPersistScheduledRules(
    database,
    true,
    timing
  );
  return {
    ...scanResult,
    generatedAlerts: [...scanResult.generatedAlerts, ...scheduledAlerts],
  };
}

export async function saveMovement(event: MovementEvent) {
  const database = await getDatabase();
  const saved = {
    ...event,
    hardwareIds: [...event.hardwareIds],
    createdAt: event.createdAt ?? new Date().toISOString(),
    denialCode:
      event.result === "denied"
        ? event.denialCode ?? denialCodeForReason(event.reason)
        : undefined,
  };
  await database.query(
    `INSERT INTO movements (
       id, subject_id, checkpoint_id, occurred_at, denial_code, result,
       direction, scan_type, subject_type, sync_state, data
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       subject_id = EXCLUDED.subject_id,
       checkpoint_id = EXCLUDED.checkpoint_id,
       occurred_at = EXCLUDED.occurred_at,
       denial_code = EXCLUDED.denial_code,
       result = EXCLUDED.result,
       direction = EXCLUDED.direction,
       scan_type = EXCLUDED.scan_type,
       subject_type = EXCLUDED.subject_type,
       sync_state = EXCLUDED.sync_state,
       data = EXCLUDED.data`,
    [
      saved.id,
      saved.subjectId,
      saved.checkpointId,
      saved.createdAt,
      saved.denialCode ?? null,
      saved.result,
      saved.direction,
      saved.scanType ?? "manual",
      saved.subjectType,
      saved.syncState,
      JSON.stringify(saved),
    ]
  );
  return clone(saved);
}

async function persistMovementStates(
  database: Queryable,
  movements: MovementEvent[]
) {
  if (movements.length === 0) return;
  await database.query(
    `UPDATE movements AS movement
     SET sync_state = item.sync_state,
         data = item.data
     FROM jsonb_to_recordset($1::jsonb)
       AS item(id text, sync_state text, data jsonb)
     WHERE movement.id = item.id`,
    [
      JSON.stringify(
        movements.map((movement) => ({
          id: movement.id,
          sync_state: movement.syncState,
          data: movement,
        }))
      ),
    ]
  );
}

export async function syncMovements(eventIds?: string[]) {
  const database = await getDatabase();
  const ids = eventIds ? [...new Set(eventIds)] : [];
  if (eventIds && ids.length === 0) return [] as MovementEvent[];
  const idFilter = ids.length ? " AND id = ANY($1::text[])" : "";
  const movements = await queryJsonRows<MovementEvent>(
    database,
    `SELECT data
     FROM movements
     WHERE sync_state = 'queued'${idFilter}`,
    ids.length ? [ids] : []
  );
  const updates = movements.map(
    (event): MovementEvent => ({
      ...event,
      syncState: event.result === "approved" ? "synced" : "conflict",
    })
  );
  await persistMovementStates(database, updates);
  return clone(updates);
}

export async function resolveMovementConflicts(eventIds: string[]) {
  const database = await getDatabase();
  const ids = [...new Set(eventIds)];
  if (ids.length === 0) return [] as MovementEvent[];
  const movements = await queryJsonRows<MovementEvent>(
    database,
    `SELECT data
     FROM movements
     WHERE sync_state = 'conflict'
       AND id = ANY($1::text[])`,
    [ids]
  );
  const updates = movements.map(
    (event): MovementEvent => ({
      ...event,
      syncState: "synced",
    })
  );
  await persistMovementStates(database, updates);
  return clone(updates);
}

export async function addMovementNote(eventId: string, note: string) {
  const database = await getDatabase();
  const trimmed = note.trim();
  const event = await database.query<{ id: string }>(
    "SELECT id FROM movements WHERE id = $1",
    [eventId]
  );
  if (!event.rows[0]) throw new Error(`Movement ${eventId} was not found.`);
  if (trimmed) {
    await database.query(
      `INSERT INTO movement_notes (event_id, note, created_at)
       VALUES ($1, $2, $3)`,
      [eventId, trimmed, new Date().toISOString()]
    );
  }
  return (await getMovementNotes(database, [eventId]))[eventId] ?? [];
}
