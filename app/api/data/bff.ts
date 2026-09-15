import { NextRequest, NextResponse } from "next/server";
import type { DataScope } from "../../../lib/types";
import {
  normalizeAlertsSnapshot,
  normalizeDashboardMovement,
  normalizeDashboardSnapshot,
  normalizeLogsSnapshot,
  normalizePermissionsSnapshot,
  normalizeRegistrySnapshot,
  normalizeTerminalSnapshot,
} from "../../../lib/normalizeDashboard";
import { callPythonApi } from "../pythonApi";

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

const DATA_SCOPES = new Set<DataScope>([
  "dashboard",
  "logs",
  "registry",
  "permissions",
  "alerts",
  "profile",
  "terminal",
  "all",
]);

const SCOPE_TO_ENDPOINT: Partial<Record<DataScope, string>> = {
  dashboard: "/v1/dashboard",
  all: "/v1/dashboard",
  alerts: "/v1/alerts",
  permissions: "/v1/permissions",
  logs: "/v1/audit-events",
  registry: "/v1/registry/bundle",
  terminal: "/v1/terminal/bundle",
};

function normalizeScope(rawScope: string | null): DataScope {
  return DATA_SCOPES.has(rawScope as DataScope) ? (rawScope as DataScope) : "all";
}

export async function handleGet(request: NextRequest, timing: ServerTiming) {
  if (request.nextUrl.searchParams.get("resource") === "movements") {
    const queryParams = new URLSearchParams(request.nextUrl.searchParams.toString());
    queryParams.delete("resource");
    const page = await callPythonApi(`/v1/movements?${queryParams.toString()}`, "GET");
    return response(
      {
        ...page,
        items: page.items.map(normalizeDashboardMovement),
        chartItems: page.chartItems.map(normalizeDashboardMovement),
      },
      timing
    );
  }

  const scope = normalizeScope(request.nextUrl.searchParams.get("scope"));
  const raw = await callPythonApi(SCOPE_TO_ENDPOINT[scope] ?? "/v1/dashboard", "GET");

  const snapshot = (() => {
    switch (scope) {
      case "alerts": return normalizeAlertsSnapshot(raw);
      case "permissions": return normalizePermissionsSnapshot(raw);
      case "logs": return normalizeLogsSnapshot(raw);
      case "registry": return normalizeRegistrySnapshot(raw);
      case "terminal": return normalizeTerminalSnapshot(raw);
      default: return normalizeDashboardSnapshot(raw);
    }
  })();

  return response(snapshot, timing);
}
