import { NextRequest, NextResponse } from "next/server";
import type { DataScope } from "../../../lib/types";
import { DATA_SCOPE_ENDPOINTS, DATA_SCOPES } from "../../../lib/dataScopes";
import {
  normalizeAuditEvent,
  normalizeAlert,
  normalizeDashboardMovement,
  normalizeDataScope,
  normalizeAccessPermission,
} from "../../../lib/normalizeDashboard";
import { normalizeSubjectZones } from "../../../lib/facilityZones";
import { callPythonApi } from "../pythonApi";
import { loadAllAlerts } from "./serverQueries";
import { ServerTiming } from "../../../lib/serverTiming";
import { recordPathSegment } from "../../../lib/apiPath";
export { ServerTiming } from "../../../lib/serverTiming";

export class CommandValidationError extends Error {
  readonly status = 400;
}

export function response<T>(data: T, timing: ServerTiming, status = 200) {
  const startedAt = performance.now();
  const body = JSON.stringify({ data });
  timing.add("serialize", performance.now() - startedAt);
  return new NextResponse(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Server-Timing": timing.header(),
    },
  });
}

export function errorResponse(message: string, timing: ServerTiming, status: number, retryAfter?: string) {
  const startedAt = performance.now();
  const body = JSON.stringify({ error: message });
  timing.add("serialize", performance.now() - startedAt);
  return new NextResponse(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Server-Timing": timing.header(),
      ...(retryAfter ? { "Retry-After": retryAfter } : {}),
    },
  });
}

export function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CommandValidationError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new CommandValidationError(`${label} is required.`);
  }
  return value.trim();
}

export function requireRecordPathSegment(value: unknown, label: string): string {
  try {
    return recordPathSegment(value, label);
  } catch {
    throw new CommandValidationError(`${label} must be a valid record identifier.`);
  }
}

function normalizeScope(rawScope: string | null): DataScope {
  return DATA_SCOPES.has(rawScope as DataScope) ? (rawScope as DataScope) : "all";
}

function normalizeCheckpointLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const checkpoint = item as Record<string, unknown>;
    const label = typeof checkpoint.name === "string"
      ? checkpoint.name
      : typeof checkpoint.id === "string" ? checkpoint.id : "";
    return label ? [label] : [];
  });
}

export async function handleGet(request: NextRequest, timing: ServerTiming) {
  const load = (path: string) => callPythonApi(path, "GET", undefined, undefined, { signal: request.signal });
  const resource = request.nextUrl.searchParams.get("resource");
  if (resource === "export") {
    const query = new URLSearchParams(request.nextUrl.searchParams);
    query.delete("resource");
    const raw = await load(`/v1/exports?${query}`);
    const source = query.get("source");
    const normalize = source === "movements" ? normalizeDashboardMovement : source === "alerts" ? normalizeAlert : normalizeAuditEvent;
    return response(source === "registry" ? { ...raw,
      people: (raw.people ?? []).map(normalizeSubjectZones), hardwareAssets: (raw.hardwareAssets ?? []).map(normalizeSubjectZones),
    } : { ...raw, items: (raw.items ?? []).map(normalize) }, timing);
  }
  if (resource === "registryPage" || resource === "registrySubjects" || resource === "subjectProfile") {
    const query = new URLSearchParams(request.nextUrl.searchParams);
    query.delete("resource");
    if (resource === "subjectProfile" && (!query.get("subjectId")?.trim() || query.get("subjectId")!.length > 200)) {
      return errorResponse("Subject ID must contain 1 to 200 characters.", timing, 400);
    }
    const raw = await load(`/v1/registry/${resource === "registrySubjects" ? "subjects" : "bundle"}?${query}`);
    const subject = (record: Record<string, unknown>) => normalizeSubjectZones(record);
    if (resource === "subjectProfile") return response({ ...raw,
      person: raw.person ? subject(raw.person) : undefined,
      hardwareAsset: raw.hardwareAsset ? subject(raw.hardwareAsset) : undefined,
      permissions: (raw.permissions ?? []).map(normalizeAccessPermission),
    }, timing);
    if (resource === "registrySubjects") return response({ ...raw, items: raw.items.map((record: Record<string, unknown>) => subject({
      ...(record.data as Record<string, unknown>), id: record.id, barcode: record.barcode, type: record.kind,
      inside: Boolean((record.data as Record<string, unknown>)?.inside),
    })) }, timing);
    return response({ ...raw, people: (raw.people ?? []).map(subject), hardwareAssets: (raw.hardwareAssets ?? []).map(subject),
      movements: (raw.movements ?? []).map(normalizeDashboardMovement) }, timing);
  }
  if (resource === "openAlertCount") {
    const alerts = await load("/v1/alerts?view=count&status=active");
    return response(alerts.total, timing);
  }
  if (resource === "alertRuleAssignments") {
    const subjectId = request.nextUrl.searchParams.get("subjectId")?.trim();
    if (!subjectId || subjectId.length > 200) {
      return errorResponse("Subject ID must contain 1 to 200 characters.", timing, 400);
    }
    const query = new URLSearchParams({ subjectId });
    return response(await load(`/v1/alert-rule-assignments?${query}`), timing);
  }
  if (resource === "dashboardAnalytics" || resource === "employeeActivity" || resource === "employeeActivitySummary") {
    const query = new URLSearchParams(request.nextUrl.searchParams.toString());
    query.delete("resource");
    const endpoint = resource === "dashboardAnalytics"
      ? "dashboard-analytics"
      : resource === "employeeActivitySummary" ? "employee-activity-summary" : "employee-activity";
    return response(await load(`/v1/movements/${endpoint}?${query}`), timing);
  }
  if (request.nextUrl.searchParams.get("resource") === "movements") {
    const queryParams = new URLSearchParams(request.nextUrl.searchParams.toString());
    queryParams.delete("resource");
    const includeChart = queryParams.get("includeChart") !== "false";
    queryParams.delete("includeChart");
    const query = queryParams.toString();
    const pageRequest = load(`/v1/movements?${query}`);
    const analyticsRequest = includeChart
      ? load(`/v1/movements/analytics?${query}`)
      : Promise.resolve({ items: [], checkpoints: [], summary: {}, buckets: [] });
    const [page, analytics] = await Promise.all([pageRequest, analyticsRequest]);
    return response(
      timing.measure("normalize", () => ({
        ...page,
        items: page.items.map(normalizeDashboardMovement),
        chartItems: analytics.items.map(normalizeDashboardMovement),
        checkpoints: normalizeCheckpointLabels(analytics.checkpoints),
        analytics: analytics.summary,
        chartBuckets: analytics.buckets,
      })),
      timing
    );
  }

  if (request.nextUrl.searchParams.get("resource") === "auditEvents") {
    const queryParams = new URLSearchParams(request.nextUrl.searchParams.toString());
    queryParams.delete("resource");
    const query = queryParams.toString();
    const raw = await load(`/v1/audit-events${query ? `?${query}` : ""}`);
    return response(
      timing.measure("normalize", () => ({ ...raw, items: (raw.items ?? []).map(normalizeAuditEvent) })),
      timing
    );
  }

  if (request.nextUrl.searchParams.get("resource") === "alerts") {
    const queryParams = new URLSearchParams(request.nextUrl.searchParams.toString());
    queryParams.delete("resource");
    const query = queryParams.toString();
    const raw = await load(`/v1/alerts${query ? `?${query}` : ""}`);
    return response(
      timing.measure("normalize", () => ({ ...raw, items: (raw.items ?? []).map(normalizeAlert),
        ...(Array.isArray(raw.currentWarnings) ? { currentWarnings: raw.currentWarnings.map(normalizeAlert) } : {}),
        ...(Array.isArray(raw.recentAlerts) ? { recentAlerts: raw.recentAlerts.map(normalizeAlert) } : {}),
      })),
      timing
    );
  }

  const scope = normalizeScope(request.nextUrl.searchParams.get("scope"));
  const raw = scope === "alerts"
    ? await loadAllAlerts(request.signal)
    : await load(DATA_SCOPE_ENDPOINTS[scope] ?? "/v1/dashboard");
  const snapshot = timing.measure("normalize", () => normalizeDataScope(scope, raw));

  return response(snapshot, timing);
}
