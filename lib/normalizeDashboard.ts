/**
 * Normalizes raw Python API responses into full AppDataSnapshot shapes.
 *
 * Each Python scope endpoint returns a different shape. This module provides
 * a single normalizer per scope so ScopedDataProvider (SSR) and /api/data
 * (client refresh) both produce identical AppDataSnapshot objects.
 */

import type {
  Alert,
  AlertWarningSummary,
  AlertRuleAssignment,
  AccessPermission,
  AppDataSnapshot,
  AuditEvent,
  MovementEvent,
  PermissionRequest,
} from "./types";
import type { DataScope } from "./types";
import { canonicalCheckpointId, normalizeFacilityCheckpoints, normalizeFacilityZones, normalizeSubjectZones } from "./facilityZones";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function normalizeDashboardMovement(raw: Record<string, unknown>): MovementEvent {
  const data = (raw.data ?? raw) as Record<string, unknown>;
  const occurredAt = (raw.occurred_at ?? raw.occurredAt ?? data.createdAt ?? "") as string;
  const date = occurredAt ? occurredAt.split("T")[0] : "";
  const time = occurredAt ? occurredAt.split("T")[1]?.slice(0, 5) ?? "" : "";
  return {
    id:           (raw.id ?? data.id ?? "") as string,
    date:         (data.date as string | undefined) ?? date,
    time:         (data.time as string | undefined) ?? time,
    checkpointId: canonicalCheckpointId((raw.checkpoint_id ?? data.checkpointId ?? "") as string),
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
    source: data.source === "paper_register" ? "paper_register" : undefined,
    paperReference: typeof data.paperReference === "string" ? data.paperReference : undefined,
    loggedAt: typeof data.loggedAt === "string" ? data.loggedAt : undefined,
    historicalVisitId: typeof data.historicalVisitId === "string" ? data.historicalVisitId : undefined,
    manualReviewedAt: typeof data.manualReviewedAt === "string" ? data.manualReviewedAt : undefined,
    overrideRequestId: typeof data.overrideRequestId === "string" ? data.overrideRequestId : undefined,
    manualApprovalRequestId: typeof data.manualApprovalRequestId === "string" ? data.manualApprovalRequestId : undefined,
  };
}

export function normalizeAlert(raw: unknown): Alert {
  // Python /v1/alerts returns a.data directly (already flat)
  const a = (raw ?? {}) as Record<string, unknown>;
  const review = a.review && typeof a.review === "object" ? a.review as Record<string, unknown> : undefined;
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
    subjectType: a.subjectType === "employee" || a.subjectType === "visitor" || a.subjectType === "hardware"
      ? a.subjectType
      : undefined,
    category:      a.category as Alert["category"] | undefined,
    ruleId:        a.ruleId as string | undefined,
    explanation:   a.explanation as string | undefined,
    subjectId: typeof a.subjectId === "string" ? a.subjectId : undefined,
    review: review && (review.decision === "confirmed" || review.decision === "excused") ? {
      decision: review.decision, reason: typeof review.reason === "string" ? review.reason : "",
      reviewedAt: typeof review.reviewedAt === "string" ? review.reviewedAt : "",
      reviewedBy: typeof review.reviewedBy === "string" ? review.reviewedBy : "",
    } : undefined,
    warningCount: typeof a.warningCount === "number" && Number.isSafeInteger(a.warningCount) && a.warningCount >= 0 ? a.warningCount : 0,
    warningResetAt: typeof a.warningResetAt === "string" ? a.warningResetAt : undefined,
    warningResetBy: typeof a.warningResetBy === "string" ? a.warningResetBy : undefined,
    warningResetReason: typeof a.warningResetReason === "string" ? a.warningResetReason : undefined,
    warningReset: a.warningReset && typeof a.warningReset === "object" ? a.warningReset as Alert["warningReset"] : undefined,
    entryRestriction: a.entryRestriction && typeof a.entryRestriction === "object" ? a.entryRestriction as Alert["entryRestriction"] : undefined,
    sourceEventId: a.sourceEventId as string | undefined,
    createdAt:     a.createdAt as string | undefined,
  };
}

export function normalizeAlertWarningSummary(raw: unknown): AlertWarningSummary {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    subjectId: typeof value.subjectId === "string" ? value.subjectId : "",
    subjectName: typeof value.subjectName === "string" ? value.subjectName : "Unknown subject",
    subjectType: value.subjectType === "hardware" ? "hardware" : "employee",
    barcode: typeof value.barcode === "string" ? value.barcode : "",
    count: typeof value.count === "number" && Number.isSafeInteger(value.count) && value.count >= 0 ? value.count : 0,
    resetAt: typeof value.resetAt === "string" ? value.resetAt : undefined,
    resetBy: typeof value.resetBy === "string" ? value.resetBy : undefined,
    resetReason: typeof value.resetReason === "string" ? value.resetReason : undefined,
    entryRestriction: value.entryRestriction && typeof value.entryRestriction === "object" ? value.entryRestriction as AlertWarningSummary["entryRestriction"] : undefined,
  };
}

export function normalizeAlertRuleAssignment(raw: unknown): AlertRuleAssignment {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    subjectId: typeof value.subjectId === "string" ? value.subjectId : "",
    subjectName: typeof value.subjectName === "string" ? value.subjectName : "Unknown subject",
    subjectType: value.subjectType === "hardware" ? "hardware" : "employee",
    barcode: typeof value.barcode === "string" ? value.barcode : "",
    ruleIds: Array.isArray(value.ruleIds) ? value.ruleIds.filter((id): id is string => typeof id === "string") : [],
    irregularitySkipDates: Array.isArray(value.irregularitySkipDates) ? [...new Set(value.irregularitySkipDates.filter((day): day is string => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day)))].sort() : [],
    source: value.source === "custom" ? "custom" : "default",
    revision: typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
  };
}

function isRemovedAlert(raw: unknown): boolean {
  const alert = (raw ?? {}) as Record<string, unknown>;
  const title = String(alert.title ?? "").toLowerCase();
  return alert.ruleId === "rule-unknown-barcode" ||
    title.startsWith("unknown barcode") ||
    title === "access decision denied";
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

export function normalizePermissionRequest(raw: unknown): PermissionRequest {
  const request = (raw ?? {}) as Record<string, unknown>;
  const requestedZones = normalizeFacilityZones(request.requestedZones);
  const type = request.type === "visitor" || request.type === "hardware_custody" || request.type === "zone_access"
    ? request.type
    : "manual_override";
  const status = request.status === "approved" || request.status === "denied"
    ? request.status
    : "pending";

  return {
    id: typeof request.id === "string" ? request.id : "",
    type,
    subjectId: typeof request.subjectId === "string" ? request.subjectId : "",
    subjectName: typeof request.subjectName === "string" ? request.subjectName : "Unknown subject",
    requester: typeof request.requester === "string" ? request.requester : "Unknown requester",
    purpose: typeof request.purpose === "string" ? request.purpose : "Manual review requested",
    requestedZones,
    validFrom: typeof request.validFrom === "string" ? request.validFrom : "",
    validTo: typeof request.validTo === "string" ? request.validTo : "",
    status,
    createdAt: typeof request.createdAt === "string" ? request.createdAt : "",
    hardwareId: typeof request.hardwareId === "string" ? request.hardwareId : undefined,
    carrierId: typeof request.carrierId === "string" ? request.carrierId : undefined,
    carrierName: typeof request.carrierName === "string" ? request.carrierName : undefined,
    checkpointId: typeof request.checkpointId === "string" ? canonicalCheckpointId(request.checkpointId) : undefined,
    checkpoint: typeof request.checkpoint === "string" ? request.checkpoint : undefined,
    direction: request.direction === "entry" || request.direction === "exit" ? request.direction : undefined,
    eventId: typeof request.eventId === "string" ? request.eventId : undefined,
    barcode: typeof request.barcode === "string" ? request.barcode : undefined,
    operatorNote: typeof request.operatorNote === "string" ? request.operatorNote : undefined,
    decisionReason: typeof request.decisionReason === "string" ? request.decisionReason : undefined,
    notificationDismissedAt: typeof request.notificationDismissedAt === "string" ? request.notificationDismissedAt : undefined,
    notificationDismissedBy: typeof request.notificationDismissedBy === "string" ? request.notificationDismissedBy : undefined,
    decidedAt: typeof request.decidedAt === "string" ? request.decidedAt : undefined,
    consumedAt: typeof request.consumedAt === "string" ? request.consumedAt : undefined,
    consumedMovementId: typeof request.consumedMovementId === "string" ? request.consumedMovementId : undefined,
    consumedBy: typeof request.consumedBy === "string" ? request.consumedBy : undefined,
    previousCarrierId: typeof request.previousCarrierId === "string" ? request.previousCarrierId : undefined,
    previousCarrierName: typeof request.previousCarrierName === "string" ? request.previousCarrierName : undefined,
    previousZones: Array.isArray(request.previousZones) ? normalizeFacilityZones(request.previousZones) : undefined,
    previousValidFrom: typeof request.previousValidFrom === "string" ? request.previousValidFrom : undefined,
    previousValidTo: typeof request.previousValidTo === "string" ? request.previousValidTo : undefined,
  };
}

export function normalizeAccessPermission(raw: unknown): AccessPermission {
  const permission = (raw ?? {}) as Record<string, unknown>;
  const subjectType = permission.subjectType === "visitor" || permission.subjectType === "hardware"
    ? permission.subjectType
    : "employee";
  const state = permission.state === "restricted" || permission.state === "pending_approval" || permission.state === "expired" || permission.state === "revoked"
    ? permission.state
    : "active";
  const source = permission.source === "manual" || permission.source === "request"
    ? permission.source
    : "policy";
  const zones = normalizeFacilityZones(permission.zones);

  return {
    id: typeof permission.id === "string" ? permission.id : "",
    subjectId: typeof permission.subjectId === "string" ? permission.subjectId : "",
    subjectName: typeof permission.subjectName === "string" ? permission.subjectName : "Unknown subject",
    subjectType,
    assignment: typeof permission.assignment === "string" ? permission.assignment : "Access permission",
    state,
    zones,
    validFrom: typeof permission.validFrom === "string" ? permission.validFrom : "",
    validTo: typeof permission.validTo === "string" ? permission.validTo : "",
    source,
    reason: typeof permission.reason === "string" ? permission.reason : undefined,
    updatedAt: typeof permission.updatedAt === "string" ? permission.updatedAt : "",
    updatedBy: typeof permission.updatedBy === "string" ? permission.updatedBy : "",
    entryRestriction: permission.entryRestriction && typeof permission.entryRestriction === "object"
      ? permission.entryRestriction as AccessPermission["entryRestriction"] : undefined,
  };
}

export function normalizeAuditEvent(raw: unknown): AuditEvent {
  const a = (raw ?? {}) as Record<string, unknown>;
  const createdAt = (a.createdAt ?? a.timestamp ?? "") as string;
  const date = (a.date ?? (createdAt ? createdAt.slice(0, 10) : "")) as string;
  const time = (a.time ?? (createdAt ? createdAt.slice(11, 16) : "")) as string;
  return {
    id:          (a.id ?? "") as string,
    category:    (a.category ?? "permission") as AuditEvent["category"],
    action:      (a.action ?? "") as string,
    subjectId:   (a.subjectId ?? "") as string,
    subjectName: (a.subjectName ?? "") as string,
    barcode:     (a.barcode ?? "") as string,
    actor:       (a.actor ?? a.performedBy ?? "") as string,
    role:        (a.role ?? "admin") as string,
    decision:    a.decision as AuditEvent["decision"] | undefined,
    reason:      (a.reason ?? a.decisionReason ?? "") as string,
    relatedId:   (a.relatedId ?? "") as string,
    date,
    time,
    createdAt,
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
  alertRules:         [],
  alertWarnings:      [],
  alertRuleAssignments: [],
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
    alerts:     rawAlerts
      .filter((item) => {
        const entry = (item ?? {}) as Record<string, unknown>;
        return !isRemovedAlert(entry.data ?? entry);
      })
      .map(normalizeDashboardAlert),
    permissionRequests: ((r.pendingDecisions ?? []) as unknown[]).map(normalizePermissionRequest),
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
    people: (Array.isArray(r.people) ? r.people : []).map((person) => normalizeSubjectZones(person as AppDataSnapshot["people"][number])),
    alerts:     items.filter((item) => !isRemovedAlert(item)).map(normalizeAlert),
    alertWarnings: (Array.isArray(r.warnings) ? r.warnings : []).map(normalizeAlertWarningSummary),
    alertRuleAssignments: (Array.isArray(r.assignments) ? r.assignments : []).map(normalizeAlertRuleAssignment),
    alertRules: rules.map((rule) => ({
      id:             (rule.id ?? "") as string,
      name:           (rule.name ?? "") as string,
      description:    (rule.description ?? "") as string,
      category:       (rule.category ?? "alert") as NonNullable<Alert["category"]>,
      severity:       (rule.severity ?? "medium") as Alert["severity"],
      enabled:        (rule.enabled ?? true) as boolean,
      scope:          (rule.scope ?? "") as string,
      conditionKey:   (rule.conditionKey ?? "irregularity") as "no_break" | "irregularity",
      recentTriggers: (rule.recentTriggers ?? 0) as number,
      eligibleSubjectTypes: (Array.isArray(rule.eligibleSubjectTypes) ? rule.eligibleSubjectTypes : ["employee"]).filter((kind): kind is "employee" | "hardware" => kind === "employee" || kind === "hardware"),
    })).filter((rule) =>
      String(rule.conditionKey) !== "manual_review" &&
      String(rule.conditionKey) !== "unknown_barcode" &&
      String(rule.conditionKey) !== "exit_balance" &&
      String(rule.conditionKey) !== "restricted_employee_entry" &&
      String(rule.conditionKey) !== "unauthorized_hardware_carrier" &&
      rule.id !== "rule-manual-review" &&
      rule.id !== "rule-unknown-barcode" &&
      rule.id !== "rule-exit-balance" &&
      rule.id !== "rule-restricted-entry" &&
      rule.id !== "rule-unauthorized-hardware"
    ),
  };
}

/** /v1/permissions → AppDataSnapshot */
export function normalizePermissionsSnapshot(raw: unknown): AppDataSnapshot {
  const r = (raw ?? {}) as Record<string, unknown>;
  const hasGroupedPermissions = Array.isArray(r.people) || Array.isArray(r.hardware);
  const rawPermissions = hasGroupedPermissions
    ? [
        ...(Array.isArray(r.people) ? r.people : []),
        ...(Array.isArray(r.hardware) ? r.hardware : []),
      ]
    : Array.isArray(r.permissions)
      ? r.permissions
      : [];
  return {
    ...EMPTY,
    people: (Array.isArray(r.subjects) ? r.subjects.filter((item) => item.type !== "hardware").map(normalizeSubjectZones) : []) as AppDataSnapshot["people"],
    hardwareAssets: (Array.isArray(r.subjects) ? r.subjects.filter((item) => item.type === "hardware").map(normalizeSubjectZones) : []) as AppDataSnapshot["hardwareAssets"],
    checkpoints: normalizeFacilityCheckpoints(r.checkpoints),
    permissions:        rawPermissions.map(normalizeAccessPermission),
    permissionRequests: ((r.requests      ?? []) as unknown[]).map(normalizePermissionRequest),
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
    people:         ((r.people ?? []) as AppDataSnapshot["people"]).map(normalizeSubjectZones),
    hardwareAssets: ((r.hardwareAssets ?? []) as AppDataSnapshot["hardwareAssets"]).map(normalizeSubjectZones),
    movements:      ((r.movements      ?? []) as Record<string, unknown>[]).map(normalizeDashboardMovement),
    permissions:    ((r.permissions ?? []) as unknown[]).map(normalizeAccessPermission),
    permissionRequests: ((r.permissionRequests ?? []) as unknown[]).map(normalizePermissionRequest),
    checkpoints: normalizeFacilityCheckpoints(r.checkpoints),
    auditEvents:    ((r.auditEvents    ?? []) as unknown[]).map(normalizeAuditEvent),
    alerts: ((r.alerts ?? []) as unknown[]).map(normalizeAlert),
    alertWarnings: (Array.isArray(r.warnings) ? r.warnings : []).map(normalizeAlertWarningSummary),
  };
}

/** /v1/terminal/bundle → pass-through (already AppDataSnapshot-compatible) */
export function normalizeTerminalSnapshot(raw: unknown): AppDataSnapshot {
  const r = raw as {
    subjects?: Array<Record<string, unknown>>;
    hardwareAssets?: AppDataSnapshot["hardwareAssets"];
    presence?: Array<{ subjectId: string; state: string }>;
    checkpoints?: AppDataSnapshot["checkpoints"];
    movements?: unknown[];
    permissionRequests?: unknown[];
    adminAvailability?: AppDataSnapshot["adminAvailability"];
    terminalAssignment?: AppDataSnapshot["terminalAssignment"];
  };
  const presence = new Map((r.presence ?? []).map(p => [p.subjectId, p.state === "inside"]));
  const subjects: Record<string, unknown>[] = (r.subjects ?? []).map(s => normalizeSubjectZones({ ...s, allowedZones: s.allowedZones, type: s.type ?? s.kind, inside: presence.get(String(s.id)) ?? Boolean(s.inside) }));
  return {
    ...EMPTY,
    checkpoints: normalizeFacilityCheckpoints(r.checkpoints).filter(checkpoint => !r.terminalAssignment || checkpoint.id === r.terminalAssignment.checkpointId),
    terminalAssignment: r.terminalAssignment,
    people: subjects.filter(s => s.type !== "hardware") as AppDataSnapshot["people"],
    hardwareAssets: r.hardwareAssets?.map(normalizeSubjectZones) ?? (subjects.filter(s => s.type === "hardware") as AppDataSnapshot["hardwareAssets"]),
    movements: ((r.movements ?? []) as Record<string, unknown>[]).map(normalizeDashboardMovement),
    permissionRequests: ((r.permissionRequests ?? []) as unknown[]).map(normalizePermissionRequest),
    adminAvailability: r.adminAvailability && typeof r.adminAvailability === "object"
      ? r.adminAvailability as AppDataSnapshot["adminAvailability"]
      : undefined,
  };

}

/** Normalize any backend bundle using the same mapping for SSR and BFF loads. */
export function normalizeDataScope(scope: DataScope, raw: unknown): AppDataSnapshot {
  switch (scope) {
    case "alerts":
      return normalizeAlertsSnapshot(raw);
    case "permissions":
      return normalizePermissionsSnapshot(raw);
    case "logs":
      return normalizeLogsSnapshot(raw);
    case "registry":
      return normalizeRegistrySnapshot(raw);
    case "terminal":
      return normalizeTerminalSnapshot(raw);
    case "dashboard":
    case "all":
    case "profile":
    default:
      return normalizeDashboardSnapshot(raw);
  }
}
