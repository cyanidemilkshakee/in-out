import { NextRequest, NextResponse } from "next/server";
import type { DataScope } from "../../../lib/types";
import { DATA_SCOPE_ENDPOINTS, DATA_SCOPES } from "../../../lib/dataScopes";
import {
  normalizeAuditEvent,
  normalizeAlert,
  normalizeDashboardMovement,
  normalizeDataScope,
} from "../../../lib/normalizeDashboard";
import { callPythonApi } from "../pythonApi";
import { loadAllAlerts } from "./serverQueries";

export class ServerTiming {
  private timings: Record<string, number> = {};

  add(name: string, milliseconds: number) {
    this.timings[name] = (this.timings[name] || 0) + milliseconds;
  }

  header() {
    return Object.entries(this.timings)
      .map(([name, milliseconds]) => `${name};dur=${milliseconds.toFixed(2)}`)
      .join(", ");
  }
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

export function errorResponse(message: string, timing: ServerTiming, status: number) {
  const startedAt = performance.now();
  const body = JSON.stringify({ error: message });
  timing.add("serialize", performance.now() - startedAt);
  return new NextResponse(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Server-Timing": timing.header(),
    },
  });
}

export function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function normalizeScope(rawScope: string | null): DataScope {
  return DATA_SCOPES.has(rawScope as DataScope) ? (rawScope as DataScope) : "all";
}

export async function handleGet(request: NextRequest, timing: ServerTiming) {
  const resource = request.nextUrl.searchParams.get("resource");
  if (resource === "openAlertCount") {
    const alerts = await callPythonApi("/v1/alerts?status=active&limit=1", "GET");
    return response(alerts.total, timing);
  }
  if (request.nextUrl.searchParams.get("resource") === "movements") {
    const queryParams = new URLSearchParams(request.nextUrl.searchParams.toString());
    queryParams.delete("resource");
    const includeChart = queryParams.get("includeChart") !== "false";
    queryParams.delete("includeChart");
    const query = queryParams.toString();
    const pageRequest = callPythonApi(`/v1/movements?${query}`, "GET");
    const analyticsRequest = includeChart
      ? callPythonApi(`/v1/movements/analytics?${query}`, "GET")
      : Promise.resolve({ items: [], checkpoints: [], summary: {}, buckets: [] });
    const [page, analytics] = await Promise.all([pageRequest, analyticsRequest]);
    return response(
      {
        ...page,
        items: page.items.map(normalizeDashboardMovement),
        chartItems: analytics.items.map(normalizeDashboardMovement),
        checkpoints: analytics.checkpoints,
        analytics: analytics.summary,
        chartBuckets: analytics.buckets,
      },
      timing
    );
  }

  if (request.nextUrl.searchParams.get("resource") === "auditEvents") {
    const queryParams = new URLSearchParams(request.nextUrl.searchParams.toString());
    queryParams.delete("resource");
    const query = queryParams.toString();
    const raw = await callPythonApi(`/v1/audit-events${query ? `?${query}` : ""}`, "GET");
    return response(
      { ...raw, items: (raw.items ?? []).map(normalizeAuditEvent) },
      timing
    );
  }

  if (request.nextUrl.searchParams.get("resource") === "alerts") {
    const queryParams = new URLSearchParams(request.nextUrl.searchParams.toString());
    queryParams.delete("resource");
    const query = queryParams.toString();
    const raw = await callPythonApi(`/v1/alerts${query ? `?${query}` : ""}`, "GET");
    return response(
      { ...raw, items: (raw.items ?? []).map(normalizeAlert) },
      timing
    );
  }

  const scope = normalizeScope(request.nextUrl.searchParams.get("scope"));
  const raw = scope === "alerts"
    ? await loadAllAlerts()
    : await callPythonApi(DATA_SCOPE_ENDPOINTS[scope] ?? "/v1/dashboard", "GET");
  const snapshot = normalizeDataScope(scope, raw);

  return response(snapshot, timing);
}
