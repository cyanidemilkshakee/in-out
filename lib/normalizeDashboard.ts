/**
 * Normalizes raw Python API responses into full AppDataSnapshot shapes.
 *
 * Each Python scope endpoint returns a different shape. This module provides
 * a single normalizer per scope so ScopedDataProvider (SSR) and /api/data
 * (client refresh) both produce identical AppDataSnapshot objects.
 */

import type { Alert, AppDataSnapshot, AuditEvent, MovementEvent } from "./types";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function normalizeDashboardMovement(raw: Record<string, unknown>): MovementEvent {
  const data = (raw.data ?? raw) as Record<string, unknown>;
  const occurredAt = (raw.occurred_at ?? raw.occurredAt ?? "") as string;
  const date = occurredAt ? occurredAt.split("T")[0] : "";
  const time = occurredAt ? occurredAt.split("T")[1]?.slice(0, 5) ?? "" : "";
  return {
    id:           (raw.id ?? data.id ?? "") as string,
    date:         (data.date as string | undefined) ?? date,
    time:         (data.time as string | undefined) ?? time,
    checkpointId: (raw.checkpoint_id ?? data.checkpointId ?? "") as string,
    checkpoint:   (data.checkpoint ?? "") as string,
    direction:    (raw.direction ?? data.direction ?? "entry") as MovementEvent["direction"],
    subjectId:    (raw.subject_id ?? data.subjectId ?? "") as string,
    subjectName:  (data.subjectName ?? data.name ?? "") as string,
    subjectType:  (raw.subject_type ?? data.subjectType ?? "employee") as MovementEvent["subjectType"],
    barcode:      (data.barcode ?? "") as string,
    result:       (raw.result ?? data.result ?? "denied") as MovementEvent["result"],
    reason:       data.reason as string | undefined,
    denialCode:   (raw.denial_code ?? data.denialCode) as MovementEvent["denialCode"] | undefined,
    scanType:     (raw.scan_type ?? data.scanType ?? "manual") as MovementEvent["scanType"],
    syncState:    (raw.sync_state ?? data.syncState ?? "synced") as MovementEvent["syncState"],
    hardwareIds:  (data.hardwareIds ?? []) as string[],
    createdAt:    occurredAt || undefined,
  };
}

function normalizeAlert(raw: unknown): Alert {
  // Python /v1/alerts returns a.data directly (already flat)
  const a = (raw ?? {}) as Record<string, unknown>;
  return {
    id:            (a.id ?? "") as string,
    severity:      (a.severity ?? "medium") as Alert["severity"],
    status:        (a.status ?? "open") as Alert["status"],
    title:         (a.title ?? "") as string,
    reason:        (a.reason ?? "") as string,
    subjectName:   (a.subjectName ?? "") as string,
    barcode:       (a.barcode ?? "") as string,
    checkpoint:    (a.checkpoint ?? "") as string,
    date:          (a.date ?? "") as string,
    time:          (a.time ?? "") as string,
    category:      a.category as Alert["category"] | undefined,
    ruleId:        a.ruleId as string | undefined,
    explanation:   a.explanation as string | undefined,
    sourceEventId: a.sourceEventId as string | undefined,
    createdAt:     a.createdAt as string | undefined,
  };
}

function normalizeDashboardAlert(a: Record<string, unknown>): Alert {
  // /v1/dashboard openAlerts wraps fields in a.data
  const data = (a.data ?? {}) as Record<string, unknown>;
  return {
    id:            (a.id ?? data.id ?? "") as string,
    severity:      (data.severity ?? "medium") as Alert["severity"],
    status:        (data.status ?? "open") as Alert["status"],
    title:         (data.title ?? "") as string,
    reason:        (data.reason ?? "") as string,
    subjectName:   (data.subjectName ?? "") as string,
    barcode:       (data.barcode ?? "") as string,
    checkpoint:    (data.checkpoint ?? "") as string,
    date:          (data.date ?? "") as string,
    time:          (data.time ?? "") as string,
    category:      data.category as Alert["category"] | undefined,
    ruleId:        data.ruleId as string | undefined,
    explanation:   data.explanation as string | undefined,
    sourceEventId: data.sourceEventId as string | undefined,
    createdAt:     (a.created_at ?? data.createdAt) as string | undefined,
  };
}

function normalizeAuditEvent(raw: unknown): AuditEvent {
  const a = (raw ?? {}) as Record<string, unknown>;
  return {
    id:          (a.id ?? "") as string,
    category:    (a.category ?? "permission") as AuditEvent["category"],
    action:      (a.action ?? "") as string,
    subjectId:   (a.subjectId ?? "") as string,
    subjectName: (a.subjectName ?? "") as string,
    actor:       (a.actor ?? a.performedBy ?? "") as string,
    role:        (a.role ?? "admin") as string,
    decision:    a.decision as AuditEvent["decision"] | undefined,
    reason:      (a.reason ?? "") as string,
    relatedId:   (a.relatedId ?? "") as string,
    date:        (a.date ?? "") as string,
    time:        (a.time ?? "") as string,
    createdAt:   (a.createdAt ?? a.timestamp ?? "") as string,
  };
}

const EMPTY: AppDataSnapshot = {
  people:             [],
  hardwareAssets:     [],
  checkpoints:        [],
  movements:          [],
  alerts:             [],
  scanAnalytics: {
    totalScans: 0, totalApproved: 0, totalDenied: 0,
    totalEntries: 0, totalExits: 0, totalAutomatic: 0, totalManual: 0,
    totalRestricted: 0, totalExpired: 0, totalOtherDenied: 0, activeInside: 0,
  },
  movementNotes:      {},
  permissions:        [],
  permissionRequests: [],
  notifications:      [],
  alertRules:         [],
  auditEvents:        [],
};

// ---------------------------------------------------------------------------
// Per-scope normalizers (exported)
// ---------------------------------------------------------------------------

/** /v1/dashboard → AppDataSnapshot */
export function normalizeDashboardSnapshot(raw: unknown): AppDataSnapshot {
  const r = (raw ?? {}) as Record<string, unknown>;
  const analytics     = (r.analytics      ?? {}) as Record<string, number>;
  const presenceCounts = (r.presenceCounts ?? {}) as Record<string, number>;
  const rawMovements  = (r.recentMovements ?? []) as Record<string, unknown>[];
  const rawAlerts     = (r.openAlerts      ?? []) as Record<string, unknown>[];

  return {
    ...EMPTY,
    movements:  rawMovements.map(normalizeDashboardMovement),
    alerts:     rawAlerts.map(normalizeDashboardAlert),
    scanAnalytics: {
      totalScans:       analytics.totalScans       ?? 0,
      totalApproved:    analytics.totalApproved    ?? 0,
      totalDenied:      analytics.totalDenied      ?? 0,
      totalEntries:     analytics.totalEntries     ?? 0,
      totalExits:       analytics.totalExits       ?? 0,
      totalAutomatic:   analytics.totalAutomatic   ?? 0,
      totalManual:      analytics.totalManual      ?? 0,
      totalRestricted:  analytics.totalRestricted  ?? 0,
      totalExpired:     analytics.totalExpired     ?? 0,
      totalOtherDenied: analytics.totalOtherDenied ?? 0,
      activeInside:     analytics.activeInside     ?? (presenceCounts.inside ?? 0),
    },
  };
}

/** /v1/alerts → AppDataSnapshot */
export function normalizeAlertsSnapshot(raw: unknown): AppDataSnapshot {
  const r = (raw ?? {}) as Record<string, unknown>;
  const items = (r.items ?? []) as unknown[];
  const rules = (r.rules ?? []) as Record<string, unknown>[];

  return {
    ...EMPTY,
    alerts:     items.map(normalizeAlert),
    alertRules: rules.map((rule) => ({
      id:             (rule.id ?? "") as string,
      name:           (rule.name ?? "") as string,
      description:    (rule.description ?? "") as string,
      category:       (rule.category ?? "alert") as NonNullable<Alert["category"]>,
      severity:       (rule.severity ?? "medium") as Alert["severity"],
      enabled:        (rule.enabled ?? true) as boolean,
      scope:          (rule.scope ?? "") as string,
      conditionKey:   (rule.conditionKey ?? "restricted_employee_entry") as
        "exit_balance" | "no_break" | "unauthorized_hardware_carrier" | "restricted_employee_entry",
      recentTriggers: (rule.recentTriggers ?? 0) as number,
    })),
  };
}

/** /v1/permissions → AppDataSnapshot */
export function normalizePermissionsSnapshot(raw: unknown): AppDataSnapshot {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    ...EMPTY,
    permissions:        ((r.permissions   ?? []) as unknown[]) as AppDataSnapshot["permissions"],
    permissionRequests: ((r.requests      ?? []) as unknown[]) as AppDataSnapshot["permissionRequests"],
    notifications:      ((r.notifications ?? []) as unknown[]) as AppDataSnapshot["notifications"],
  };
}

/** /v1/audit-events → AppDataSnapshot (logs page needs movements + auditEvents) */
export function normalizeLogsSnapshot(raw: unknown): AppDataSnapshot {
  const r = (raw ?? {}) as Record<string, unknown>;
  const items = (r.items ?? []) as unknown[];
  return {
    ...EMPTY,
    auditEvents: items.map(normalizeAuditEvent),
    // movements are lazy-fetched by queryMovements on the logs page — start empty
    movements: [],
  };
}

/** /v1/registry/bundle → AppDataSnapshot */
export function normalizeRegistrySnapshot(raw: unknown): AppDataSnapshot {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    ...EMPTY,
    people:         ((r.people         ?? []) as unknown[]) as AppDataSnapshot["people"],
    hardwareAssets: ((r.hardwareAssets ?? []) as unknown[]) as AppDataSnapshot["hardwareAssets"],
    alerts:         ((r.alerts         ?? []) as unknown[]).map(normalizeAlert),
    permissions:    ((r.permissions    ?? []) as unknown[]) as AppDataSnapshot["permissions"],
  };
}

/** /v1/terminal/bundle → pass-through (already AppDataSnapshot-compatible) */
export function normalizeTerminalSnapshot(raw: unknown): AppDataSnapshot {
  const r = raw as { subjects?: Array<Record<string, unknown>>; presence?: Array<{ subjectId: string; state: string }>; checkpoints?: AppDataSnapshot["checkpoints"] };
  const presence = new Map((r.presence ?? []).map(p => [p.subjectId, p.state === "inside"]));
  const subjects: Record<string, unknown>[] = (r.subjects ?? []).map(s => ({ ...s, type: s.type ?? s.kind, inside: presence.get(String(s.id)) ?? Boolean(s.inside) }));
  return { ...EMPTY, checkpoints: r.checkpoints ?? [], people: subjects.filter(s => s.type !== "hardware") as AppDataSnapshot["people"], hardwareAssets: subjects.filter(s => s.type === "hardware") as AppDataSnapshot["hardwareAssets"] };

}
