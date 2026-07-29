import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
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
import { getDatabase } from "./database";
import type { TimingSink } from "./timing";

type JsonRow = { data: string };
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

function jsonRows<T>(database: DatabaseSync, sql: string, ...params: unknown[]) {
  return queryJsonRows<T>(database, sql, params);
}

function queryJsonRows<T>(
  database: DatabaseSync,
  sql: string,
  params: unknown[] = [],
  timing?: TimingSink
) {
  const queryStartedAt = performance.now();
  const rows = database
    .prepare(sql)
    .all(...(params as never[])) as unknown as JsonRow[];
  timing?.("db_query", performance.now() - queryStartedAt);

  const parseStartedAt = performance.now();
  const parsed = rows.map((row) => JSON.parse(row.data) as T);
  timing?.("json_parse", performance.now() - parseStartedAt);
  return parsed;
}

function jsonRow<T>(
  database: DatabaseSync,
  sql: string,
  ...params: unknown[]
): T | undefined {
  const row = database.prepare(sql).get(...(params as never[])) as
    | JsonRow
    | undefined;
  return row ? (JSON.parse(row.data) as T) : undefined;
}

function updateJson(
  database: DatabaseSync,
  table: string,
  idColumn: string,
  id: string,
  value: unknown
) {
  database
    .prepare(`UPDATE ${table} SET data = ? WHERE ${idColumn} = ?`)
    .run(JSON.stringify(value), id);
}

function withTransaction<T>(database: DatabaseSync, operation: () => T) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
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

function getPeople(database: DatabaseSync, timing?: TimingSink) {
  return queryJsonRows<Person>(
    database,
    "SELECT data FROM people ORDER BY subject_id",
    [],
    timing
  );
}

function getHardware(database: DatabaseSync, timing?: TimingSink) {
  return queryJsonRows<HardwareAsset>(
    database,
    "SELECT data FROM hardware_assets ORDER BY subject_id",
    [],
    timing
  );
}

function getCheckpoints(database: DatabaseSync, timing?: TimingSink) {
  return queryJsonRows<Checkpoint>(
    database,
    "SELECT data FROM checkpoints ORDER BY id",
    [],
    timing
  );
}

function getMovements(
  database: DatabaseSync,
  limit?: number,
  timing?: TimingSink
) {
  return queryJsonRows<MovementEvent>(
    database,
    `SELECT data FROM movements ORDER BY occurred_at DESC${limit ? " LIMIT ?" : ""}`,
    limit ? [limit] : [],
    timing
  );
}

function getAlerts(database: DatabaseSync, limit?: number, timing?: TimingSink) {
  return queryJsonRows<Alert>(
    database,
    `SELECT data FROM alerts ORDER BY created_at DESC${limit ? " LIMIT ?" : ""}`,
    limit ? [limit] : [],
    timing
  );
}

function getPermissions(database: DatabaseSync, timing?: TimingSink) {
  return queryJsonRows<AccessPermission>(
    database,
    "SELECT data FROM access_permissions ORDER BY id",
    [],
    timing
  );
}

function getPermissionRequests(database: DatabaseSync, timing?: TimingSink) {
  return queryJsonRows<PermissionRequest>(
    database,
    "SELECT data FROM permission_requests ORDER BY created_at DESC",
    [],
    timing
  );
}

function getNotifications(database: DatabaseSync, timing?: TimingSink) {
  return queryJsonRows<PermissionNotification>(
    database,
    "SELECT data FROM notifications ORDER BY created_at DESC",
    [],
    timing
  );
}

function getAlertRules(database: DatabaseSync, timing?: TimingSink) {
  return queryJsonRows<AlertRule>(
    database,
    "SELECT data FROM alert_rules ORDER BY id",
    [],
    timing
  );
}

function getAuditEvents(
  database: DatabaseSync,
  limit?: number,
  timing?: TimingSink
) {
  return queryJsonRows<AuditEvent>(
    database,
    `SELECT data FROM audit_events ORDER BY created_at DESC${limit ? " LIMIT ?" : ""}`,
    limit ? [limit] : [],
    timing
  );
}

function getMovementNotes(
  database: DatabaseSync,
  eventIds: string[],
  timing?: TimingSink
): MovementNotes {
  if (eventIds.length === 0) return {};
  const placeholders = eventIds.map(() => "?").join(", ");
  const startedAt = performance.now();
  const rows = database
    .prepare(
      `SELECT event_id, note
       FROM movement_notes
       WHERE event_id IN (${placeholders})
       ORDER BY id`
    )
    .all(...(eventIds as never[])) as unknown as NoteRow[];
  timing?.("db_query", performance.now() - startedAt);
  const notes: MovementNotes = {};
  for (const row of rows) {
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

function getScanAnalytics(
  database: DatabaseSync,
  timing?: TimingSink
): ScanAnalytics {
  const startedAt = performance.now();
  const row = database
    .prepare(
      `SELECT
         COUNT(*) AS totalScans,
         SUM(result = 'approved') AS totalApproved,
         SUM(result = 'denied') AS totalDenied,
         SUM(
           result = 'approved'
           AND direction = 'entry'
         ) AS totalEntries,
         SUM(
           result = 'approved'
           AND direction = 'exit'
         ) AS totalExits,
         SUM(scan_type = 'auto') AS totalAutomatic,
         SUM(scan_type = 'manual') AS totalManual,
         SUM(
           result = 'denied'
           AND denial_code IN (
             'asset_restricted',
             'access_restricted',
             'hardware_restricted',
             'zone_not_permitted'
           )
         ) AS totalRestricted,
         SUM(
           result = 'denied'
           AND denial_code = 'expired_pass'
         ) AS totalExpired
       FROM movements`
    )
    .get() as Record<string, number | null>;
  const insideRow = database
    .prepare(
      `SELECT COUNT(*) AS activeInside
       FROM people
       WHERE json_extract(data, '$.inside') = 1`
    )
    .get() as { activeInside: number };
  timing?.("db_aggregate", performance.now() - startedAt);

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

export function getSnapshot(
  scope: DataScope = "all",
  timing?: TimingSink
): AppDataSnapshot {
  const database = getDatabase();
  if (hasScope(scope, "dashboard", "alerts")) {
    evaluateAndPersistScheduledRules(database, false, timing);
  }
  const includePeople = hasScope(scope, "terminal", "registry", "permissions");
  const includeHardware = hasScope(scope, "terminal", "registry", "permissions");
  const includeMovements = hasScope(scope, "dashboard", "logs", "registry", "terminal");
  const includeAlerts = hasScope(scope, "dashboard", "logs", "registry", "alerts");
  const people = includePeople ? getPeople(database, timing) : [];
  const hardwareAssets = includeHardware ? getHardware(database, timing) : [];
  const initialMovementPage =
    scope === "logs"
      ? queryMovements(
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
  const dashboardMovementPage =
    scope === "dashboard"
      ? queryMovements(
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
      : undefined;
  const movements =
    initialMovementPage?.items ??
    dashboardMovementPage?.chartItems ??
    (includeMovements
      ? getMovements(database, movementLimitForScope(scope), timing)
      : []);
  const recordLimit = recordLimitForScope(scope);

  return {
    people,
    hardwareAssets,
    checkpoints: hasScope(scope, "terminal")
      ? getCheckpoints(database, timing)
      : [],
    movements,
    movementPage: initialMovementPage,
    alerts: includeAlerts ? getAlerts(database, recordLimit, timing) : [],
    scanAnalytics: hasScope(scope, "dashboard", "terminal")
      ? getScanAnalytics(database, timing)
      : EMPTY_ANALYTICS,
    movementNotes: initialMovementPage
      ? initialMovementPage.movementNotes
      : hasScope(scope, "logs")
      ? getMovementNotes(
          database,
          movements.map((movement) => movement.id),
          timing
        )
      : {},
    permissions: hasScope(scope, "permissions")
      ? getPermissions(database, timing)
      : [],
    permissionRequests: hasScope(scope, "permissions")
      ? getPermissionRequests(database, timing)
      : [],
    notifications: hasScope(scope, "permissions")
      ? getNotifications(database, timing)
      : [],
    alertRules: hasScope(scope, "alerts") ? getAlertRules(database, timing) : [],
    auditEvents: hasScope(scope, "logs", "registry", "permissions")
      ? getAuditEvents(database, recordLimit, timing)
      : [],
  };
}

const MOVEMENT_SORT_COLUMNS: Record<
  NonNullable<MovementQuery["sortKey"]>,
  string
> = {
  date: "occurred_at",
  time: "occurred_at",
  createdAt: "occurred_at",
  name: "json_extract(data, '$.subjectName')",
  type: "subject_type",
  direction: "direction",
  checkpoint: "json_extract(data, '$.checkpoint')",
  result: "result",
  barcode: "json_extract(data, '$.barcode')",
  scanType: "scan_type",
  eventId: "id",
};

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function queryMovements(
  query: MovementQuery,
  timing?: TimingSink
): MovementPage {
  const database = getDatabase();
  const page = Math.max(1, Math.floor(query.page || 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize || 25)));
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.startAt) {
    where.push("occurred_at >= ?");
    params.push(query.startAt);
  }
  if (query.endAt) {
    where.push("occurred_at <= ?");
    params.push(query.endAt);
  }
  if (query.checkpoint) {
    where.push("json_extract(data, '$.checkpoint') = ?");
    params.push(query.checkpoint);
  }
  if (query.result) {
    where.push("result = ?");
    params.push(query.result);
  }
  if (query.scanType) {
    where.push("scan_type = ?");
    params.push(query.scanType);
  }
  if (query.direction) {
    where.push("direction = ?");
    params.push(query.direction);
  }
  if (query.subjectGroup === "hardware") {
    where.push("subject_type = 'hardware'");
  } else if (query.subjectGroup === "people") {
    where.push("subject_type IN ('employee', 'visitor')");
  }
  const search = query.search?.trim().toLowerCase();
  if (search) {
    const needle = `%${escapeLike(search)}%`;
    where.push(
      `(
        LOWER(json_extract(data, '$.subjectName')) LIKE ? ESCAPE '\\'
        OR LOWER(json_extract(data, '$.barcode')) LIKE ? ESCAPE '\\'
        OR LOWER(json_extract(data, '$.checkpoint')) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(json_extract(data, '$.reason'), '')) LIKE ? ESCAPE '\\'
      )`
    );
    params.push(needle, needle, needle, needle);
  }

  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const sortColumn =
    MOVEMENT_SORT_COLUMNS[query.sortKey ?? "createdAt"] ?? "occurred_at";
  const sortDirection = query.sortDirection === "asc" ? "ASC" : "DESC";
  const queryStartedAt = performance.now();
  const countRow = database
    .prepare(`SELECT COUNT(*) AS count FROM movements${whereSql}`)
    .get(...(params as never[])) as { count: number };
  timing?.("db_query", performance.now() - queryStartedAt);

  const items = queryJsonRows<MovementEvent>(
    database,
    `SELECT data
     FROM movements${whereSql}
     ORDER BY ${sortColumn} ${sortDirection}, occurred_at DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
    timing
  );
  const chartItems = queryJsonRows<MovementEvent>(
    database,
    `SELECT data
     FROM movements${whereSql}
     ORDER BY occurred_at DESC
     LIMIT 2000`,
    params,
    timing
  );
  const checkpointStartedAt = performance.now();
  const checkpointRows = database
    .prepare(
      `SELECT DISTINCT json_extract(data, '$.checkpoint') AS checkpoint
       FROM movements
       WHERE json_extract(data, '$.checkpoint') IS NOT NULL
       ORDER BY checkpoint`
    )
    .all() as Array<{ checkpoint: string }>;
  timing?.("db_query", performance.now() - checkpointStartedAt);

  return {
    items,
    chartItems,
    movementNotes: getMovementNotes(
      database,
      items.map((movement) => movement.id),
      timing
    ),
    total: Number(countRow.count),
    page,
    pageSize,
    checkpoints: checkpointRows.map((row) => row.checkpoint),
  };
}

function assertBarcodeAvailable(database: DatabaseSync, barcode: string, exceptId?: string) {
  const existing = database
    .prepare("SELECT id FROM subjects WHERE UPPER(barcode) = UPPER(?)")
    .get(barcode) as { id: string } | undefined;
  if (existing && existing.id !== exceptId) {
    throw new Error(`Barcode ${barcode} is already assigned.`);
  }
}

function insertPermission(database: DatabaseSync, permission: AccessPermission) {
  database
    .prepare(
      "INSERT INTO access_permissions (id, subject_id, data) VALUES (?, ?, ?)"
    )
    .run(permission.id, permission.subjectId, JSON.stringify(permission));
}

function insertNotification(
  database: DatabaseSync,
  notification: PermissionNotification
) {
  database
    .prepare(
      "INSERT INTO notifications (id, created_at, data) VALUES (?, ?, ?)"
    )
    .run(notification.id, notification.createdAt, JSON.stringify(notification));
}

function insertAudit(database: DatabaseSync, audit: AuditEvent) {
  database
    .prepare(
      "INSERT INTO audit_events (id, created_at, data) VALUES (?, ?, ?)"
    )
    .run(audit.id, audit.createdAt, JSON.stringify(audit));
}

function evaluateAndPersistScheduledRules(
  database: DatabaseSync,
  force: boolean,
  timing?: TimingSink
) {
  const now = new Date();
  const lastRun = scheduledRuleRuns.get(database as object) ?? 0;
  if (!force && now.getTime() - lastRun < 60_000) return [] as Alert[];
  scheduledRuleRuns.set(database as object, now.getTime());

  const since = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
  const rules = queryJsonRows<AlertRule>(
    database,
    `SELECT data
     FROM alert_rules
     WHERE json_extract(data, '$.enabled') = 1
       AND json_extract(data, '$.conditionKey') IN ('exit_balance', 'no_break')`,
    [],
    timing
  );
  if (rules.length === 0) return [] as Alert[];

  const movements = queryJsonRows<MovementEvent>(
    database,
    `SELECT data
     FROM movements
     WHERE occurred_at >= ?
     ORDER BY occurred_at`,
    [since],
    timing
  );
  const people = queryJsonRows<Person>(
    database,
    `SELECT data
     FROM people
     WHERE json_extract(data, '$.type') = 'employee'`,
    [],
    timing
  );
  const existingAlerts = queryJsonRows<Alert>(
    database,
    `SELECT data
     FROM alerts
     WHERE created_at >= ?
       AND json_extract(data, '$.ruleId') IS NOT NULL`,
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

  return withTransaction(database, () =>
    candidates.map((candidate) => {
      const createdAt = candidate.createdAt ?? now.toISOString();
      const alert: Alert = {
        ...candidate,
        id: makeId("AL"),
        createdAt,
      };
      database
        .prepare(
          "INSERT INTO alerts (id, source_event_id, created_at, data) VALUES (?, ?, ?, ?)"
        )
        .run(
          alert.id,
          alert.sourceEventId ?? null,
          createdAt,
          JSON.stringify(alert)
        );
      insertAudit(database, {
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
      return clone(alert);
    })
  );
}

export function createTemporaryVisitor(input: CreateTemporaryVisitorInput) {
  const database = getDatabase();
  const barcode = input.barcode.trim().toUpperCase();
  if (!barcode) throw new Error("Visitor barcode is required.");
  assertBarcodeAvailable(database, barcode);
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

  return withTransaction(database, () => {
    database
      .prepare("INSERT INTO subjects (id, kind, barcode) VALUES (?, ?, ?)")
      .run(visitor.id, visitor.type, visitor.barcode);
    database
      .prepare("INSERT INTO people (subject_id, data) VALUES (?, ?)")
      .run(visitor.id, JSON.stringify(visitor));
    database
      .prepare(
        `INSERT INTO permission_requests
          (id, subject_id, created_at, data) VALUES (?, ?, ?, ?)`
      )
      .run(request.id, request.subjectId, request.createdAt, JSON.stringify(request));
    insertPermission(database, permission);
    insertNotification(database, notification);
    return clone(visitor);
  });
}

export function createEmployee(input: CreateEmployeeInput) {
  const database = getDatabase();
  const barcode = input.barcode.trim().toUpperCase();
  if (!barcode || !input.name.trim()) {
    throw new Error("Employee name and barcode are required.");
  }
  assertBarcodeAvailable(database, barcode);
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
  return withTransaction(database, () => {
    database
      .prepare("INSERT INTO subjects (id, kind, barcode) VALUES (?, ?, ?)")
      .run(employee.id, employee.type, employee.barcode);
    database
      .prepare("INSERT INTO people (subject_id, data) VALUES (?, ?)")
      .run(employee.id, JSON.stringify(employee));
    insertPermission(database, permission);
    return clone(employee);
  });
}

export function createHardwareAsset(input: CreateHardwareAssetInput) {
  const database = getDatabase();
  const barcode = input.barcode.trim().toUpperCase();
  if (!barcode || !input.name.trim()) {
    throw new Error("Hardware name and barcode are required.");
  }
  assertBarcodeAvailable(database, barcode);
  const now = new Date();
  const people = getPeople(database);
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
  return withTransaction(database, () => {
    database
      .prepare("INSERT INTO subjects (id, kind, barcode) VALUES (?, ?, ?)")
      .run(asset.id, "hardware", asset.barcode);
    database
      .prepare("INSERT INTO hardware_assets (subject_id, data) VALUES (?, ?)")
      .run(asset.id, JSON.stringify(asset));
    insertPermission(database, permission);
    return clone(asset);
  });
}

export function updatePerson(
  personId: string,
  patch: Partial<Omit<Person, "id">>
) {
  const database = getDatabase();
  const existing = jsonRow<Person>(
    database,
    "SELECT data FROM people WHERE subject_id = ?",
    personId
  );
  if (!existing) throw new Error(`Person ${personId} was not found.`);
  const barcode =
    typeof patch.barcode === "string"
      ? patch.barcode.trim().toUpperCase()
      : existing.barcode;
  assertBarcodeAvailable(database, barcode, personId);
  const updated: Person = { ...existing, ...patch, id: existing.id, barcode };
  return withTransaction(database, () => {
    updateJson(database, "people", "subject_id", personId, updated);
    database
      .prepare("UPDATE subjects SET barcode = ? WHERE id = ?")
      .run(updated.barcode, personId);
    return clone(updated);
  });
}

export function updateHardwareAsset(
  assetId: string,
  patch: Partial<Omit<HardwareAsset, "id">>
) {
  const database = getDatabase();
  const existing = jsonRow<HardwareAsset>(
    database,
    "SELECT data FROM hardware_assets WHERE subject_id = ?",
    assetId
  );
  if (!existing) throw new Error(`Hardware asset ${assetId} was not found.`);
  const barcode =
    typeof patch.barcode === "string"
      ? patch.barcode.trim().toUpperCase()
      : existing.barcode;
  assertBarcodeAvailable(database, barcode, assetId);
  const updated: HardwareAsset = { ...existing, ...patch, id: existing.id, barcode };
  return withTransaction(database, () => {
    updateJson(database, "hardware_assets", "subject_id", assetId, updated);
    database
      .prepare("UPDATE subjects SET barcode = ? WHERE id = ?")
      .run(updated.barcode, assetId);
    return clone(updated);
  });
}

export function updateAlert(alertId: string, patch: Partial<Omit<Alert, "id">>) {
  const database = getDatabase();
  const existing = jsonRow<Alert>(
    database,
    "SELECT data FROM alerts WHERE id = ?",
    alertId
  );
  if (!existing) throw new Error(`Alert ${alertId} was not found.`);
  const updated: Alert = { ...existing, ...patch, id: existing.id };
  updateJson(database, "alerts", "id", alertId, updated);
  return clone(updated);
}

export function updateAccessPermission(
  input: UpdateAccessPermissionInput
): AccessPermissionMutationResult {
  const database = getDatabase();
  const existing = jsonRow<AccessPermission>(
    database,
    "SELECT data FROM access_permissions WHERE subject_id = ?",
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

  return withTransaction(database, () => {
    updateJson(database, "access_permissions", "id", updated.id, updated);
    let updatedPerson: Person | undefined;
    const person = jsonRow<Person>(
      database,
      "SELECT data FROM people WHERE subject_id = ?",
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
      updateJson(
        database,
        "people",
        "subject_id",
        person.id,
        updatedPerson
      );
    }
    let updatedHardwareAsset: HardwareAsset | undefined;
    const hardware = jsonRow<HardwareAsset>(
      database,
      "SELECT data FROM hardware_assets WHERE subject_id = ?",
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
      updateJson(
        database,
        "hardware_assets",
        "subject_id",
        hardware.id,
        updatedHardwareAsset
      );
    }
    insertAudit(database, audit);
    insertNotification(database, notification);
    return clone({
      permission: updated,
      person: updatedPerson,
      hardwareAsset: updatedHardwareAsset,
      auditEvent: audit,
      notification,
    });
  });
}

export function decidePermissionRequest(
  requestId: string,
  decision: "approved" | "denied",
  reason: string
): PermissionDecisionMutationResult {
  const database = getDatabase();
  const existing = jsonRow<PermissionRequest>(
    database,
    "SELECT data FROM permission_requests WHERE id = ?",
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

  return withTransaction(database, () => {
    updateJson(database, "permission_requests", "id", requestId, updated);
    let updatedPerson: Person | undefined;
    if (existing.type === "visitor") {
      const person = jsonRow<Person>(
        database,
        "SELECT data FROM people WHERE subject_id = ?",
        existing.subjectId
      );
      if (person) {
        updatedPerson = {
          ...person,
          status: decision === "approved" ? "pre_approved" : "inactive",
        };
        updateJson(
          database,
          "people",
          "subject_id",
          person.id,
          updatedPerson
        );
      }
    }
    let updatedHardwareAsset: HardwareAsset | undefined;
    if (existing.type === "hardware_custody" && existing.hardwareId) {
      const asset = jsonRow<HardwareAsset>(
        database,
        "SELECT data FROM hardware_assets WHERE subject_id = ?",
        existing.hardwareId
      );
      if (asset && decision === "approved") {
        updatedHardwareAsset = {
          ...asset,
          assignedEmployeeId: existing.carrierId,
          assignedEmployeeName: existing.carrierName,
        };
        updateJson(
          database,
          "hardware_assets",
          "subject_id",
          asset.id,
          updatedHardwareAsset
        );
      }
    }
    const permission = jsonRow<AccessPermission>(
      database,
      "SELECT data FROM access_permissions WHERE subject_id = ?",
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
      updateJson(
        database,
        "access_permissions",
        "id",
        updatedPermission.id,
        updatedPermission
      );
    }
    insertAudit(database, audit);
    insertNotification(database, notification);
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

export function updateAlertRule(ruleId: string, enabled: boolean) {
  const database = getDatabase();
  const existing = jsonRow<AlertRule>(
    database,
    "SELECT data FROM alert_rules WHERE id = ?",
    ruleId
  );
  if (!existing) throw new Error(`Alert rule ${ruleId} was not found.`);
  const updated = { ...existing, enabled };
  updateJson(database, "alert_rules", "id", ruleId, updated);
  return clone(updated);
}

export function markNotificationRead(notificationId: string) {
  const database = getDatabase();
  const existing = jsonRow<PermissionNotification>(
    database,
    "SELECT data FROM notifications WHERE id = ?",
    notificationId
  );
  if (!existing) {
    throw new Error(`Notification ${notificationId} was not found.`);
  }
  const updated = { ...existing, read: true };
  updateJson(database, "notifications", "id", notificationId, updated);
  return clone(updated);
}

function insertMovement(database: DatabaseSync, movement: MovementEvent) {
  database
    .prepare(
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
    )
    .run(
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
      JSON.stringify(movement)
    );
}

function getSubjectByBarcode(database: DatabaseSync, barcode: string) {
  return jsonRow<Person | HardwareAsset>(
    database,
    `SELECT COALESCE(people.data, hardware_assets.data) AS data
     FROM subjects
     LEFT JOIN people ON people.subject_id = subjects.id
     LEFT JOIN hardware_assets ON hardware_assets.subject_id = subjects.id
     WHERE UPPER(subjects.barcode) = UPPER(?)
     LIMIT 1`,
    barcode.trim()
  );
}

function getHardwareByIds(database: DatabaseSync, assetIds: string[]) {
  const uniqueIds = [...new Set(assetIds)];
  if (uniqueIds.length === 0) return [] as HardwareAsset[];
  const placeholders = uniqueIds.map(() => "?").join(", ");
  return jsonRows<HardwareAsset>(
    database,
    `SELECT data
     FROM hardware_assets
     WHERE subject_id IN (${placeholders})`,
    ...uniqueIds
  );
}

export function recordScan(
  input: RecordScanInput,
  timing?: TimingSink
): RecordScanResult {
  const database = getDatabase();
  const lookupStartedAt = performance.now();
  const subject = getSubjectByBarcode(database, input.barcode);
  const checkpoint = jsonRow<Checkpoint>(
    database,
    "SELECT data FROM checkpoints WHERE id = ?",
    input.checkpointId
  );
  if (!checkpoint) {
    throw new Error(`Checkpoint ${input.checkpointId} was not found.`);
  }
  const selectedHardware = getHardwareByIds(
    database,
    input.selectedHardwareIds
  );
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

  const rules = getAlertRules(database, timing);
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
    const duplicate = database
      .prepare(
        `SELECT id
         FROM alerts
         WHERE json_extract(data, '$.ruleId') = ?
           AND json_extract(data, '$.status') = 'open'
         LIMIT 1`
      )
      .get(generatedAlert.ruleId);
    if (duplicate) generatedAlert = undefined;
  }
  timing?.("rule_evaluation", performance.now() - ruleStartedAt);

  const writeStartedAt = performance.now();
  const scanResult = withTransaction(database, () => {
    insertMovement(database, event);
    for (const person of updatedPeople) {
      updateJson(database, "people", "subject_id", person.id, person);
    }
    for (const asset of updatedHardwareAssets) {
      updateJson(database, "hardware_assets", "subject_id", asset.id, asset);
    }
    if (generatedAlert) {
      database
        .prepare(
          "INSERT INTO alerts (id, source_event_id, created_at, data) VALUES (?, ?, ?, ?)"
        )
        .run(
          generatedAlert.id,
          generatedAlert.sourceEventId ?? null,
          generatedAlert.createdAt ?? now.toISOString(),
          JSON.stringify(generatedAlert)
        );
      insertAudit(database, {
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
      const duplicate = database
        .prepare(
          `SELECT id FROM permission_requests
           WHERE json_extract(data, '$.type') = 'hardware_custody'
             AND json_extract(data, '$.hardwareId') = ?
             AND json_extract(data, '$.carrierId') = ?
             AND json_extract(data, '$.status') = 'pending'
           LIMIT 1`
        )
        .get(custodyAsset.id, carrier.id);
      if (!duplicate) {
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
        database
          .prepare(
            `INSERT INTO permission_requests
              (id, subject_id, created_at, data) VALUES (?, ?, ?, ?)`
          )
          .run(
            request.id,
            request.subjectId,
            request.createdAt,
            JSON.stringify(request)
          );
        insertNotification(database, {
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

  const scheduledAlerts = evaluateAndPersistScheduledRules(
    database,
    true,
    timing
  );
  return {
    ...scanResult,
    generatedAlerts: [...scanResult.generatedAlerts, ...scheduledAlerts],
  };
}

export function saveMovement(event: MovementEvent) {
  const database = getDatabase();
  const existing = database
    .prepare("SELECT id FROM movements WHERE id = ?")
    .get(event.id);
  const saved = {
    ...event,
    hardwareIds: [...event.hardwareIds],
    createdAt: event.createdAt ?? new Date().toISOString(),
    denialCode:
      event.result === "denied"
        ? event.denialCode ?? denialCodeForReason(event.reason)
        : undefined,
  };
  if (existing) {
    database
      .prepare(
        `UPDATE movements
         SET
           occurred_at = ?,
           denial_code = ?,
           result = ?,
           direction = ?,
           scan_type = ?,
           subject_type = ?,
           sync_state = ?,
           data = ?
         WHERE id = ?`
      )
      .run(
        saved.createdAt,
        saved.denialCode ?? null,
        saved.result,
        saved.direction,
        saved.scanType ?? "manual",
        saved.subjectType,
        saved.syncState,
        JSON.stringify(saved),
        saved.id
      );
  } else {
    insertMovement(database, saved);
  }
  return clone(saved);
}

export function syncMovements(eventIds?: string[]) {
  const database = getDatabase();
  const ids = eventIds ? [...new Set(eventIds)] : [];
  if (eventIds && ids.length === 0) return [] as MovementEvent[];
  const idFilter = ids.length
    ? ` AND id IN (${ids.map(() => "?").join(", ")})`
    : "";
  const movements = jsonRows<MovementEvent>(
    database,
    `SELECT data
     FROM movements
     WHERE sync_state = 'queued'${idFilter}`,
    ...ids
  );
  const updates = movements.map(
    (event): MovementEvent => ({
      ...event,
      syncState: event.result === "approved" ? "synced" : "conflict",
    })
  );
  return withTransaction(database, () => {
    for (const updated of updates) {
      database
        .prepare(
          "UPDATE movements SET sync_state = ?, data = ? WHERE id = ?"
        )
        .run(updated.syncState, JSON.stringify(updated), updated.id);
    }
    return clone(updates);
  });
}

export function resolveMovementConflicts(eventIds: string[]) {
  const database = getDatabase();
  const ids = [...new Set(eventIds)];
  if (ids.length === 0) return [] as MovementEvent[];
  const movements = jsonRows<MovementEvent>(
    database,
    `SELECT data
     FROM movements
     WHERE sync_state = 'conflict'
       AND id IN (${ids.map(() => "?").join(", ")})`,
    ...ids
  );
  const updates = movements.map(
    (event): MovementEvent => ({
      ...event,
      syncState: "synced",
    })
  );
  return withTransaction(database, () => {
    for (const updated of updates) {
      database
        .prepare(
          "UPDATE movements SET sync_state = ?, data = ? WHERE id = ?"
        )
        .run(updated.syncState, JSON.stringify(updated), updated.id);
    }
    return clone(updates);
  });
}

export function addMovementNote(eventId: string, note: string) {
  const database = getDatabase();
  const trimmed = note.trim();
  const event = database
    .prepare("SELECT id FROM movements WHERE id = ?")
    .get(eventId);
  if (!event) throw new Error(`Movement ${eventId} was not found.`);
  if (trimmed) {
    database
      .prepare(
        "INSERT INTO movement_notes (event_id, note, created_at) VALUES (?, ?, ?)"
      )
      .run(eventId, trimmed, new Date().toISOString());
  }
  return getMovementNotes(database, [eventId])[eventId] ?? [];
}
