import { NextRequest, NextResponse } from "next/server";
import type {
  HardwareAsset,
  MovementQuery,
  Person,
  SortDirection,
  VisibleColumn,
} from "../../../lib/types";
import type {
  CreateEmployeeInput,
  CreateHardwareAssetInput,
  CreateTemporaryVisitorInput,
  DataScope,
  RecordScanInput,
  UpdateAccessPermissionInput,
} from "../../../lib/types";

class ServerTiming {
  private timings: Record<string, number> = {};
  add = (name: string, ms: number) => { this.timings[name] = (this.timings[name] || 0) + ms; };
  header = () => Object.entries(this.timings).map(([k, v]) => `${k};dur=${v.toFixed(2)}`).join(", ");
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

function response<T>(data: T, timing: ServerTiming, status = 200) {
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

function errorResponse(message: string, timing: ServerTiming, status: number) {
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

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

import { callPythonApi, PythonApiError } from "../pythonApi";
import {
  normalizeDashboardMovement,
  normalizeDashboardSnapshot,
  normalizeAlertsSnapshot,
  normalizePermissionsSnapshot,
  normalizeLogsSnapshot,
  normalizeRegistrySnapshot,
  normalizeTerminalSnapshot,
} from "../../../lib/normalizeDashboard";

const SCOPE_TO_ENDPOINT: Partial<Record<DataScope, string>> = {
  dashboard:   "/v1/dashboard",
  all:         "/v1/dashboard",
  alerts:      "/v1/alerts",
  permissions: "/v1/permissions",
  logs:        "/v1/audit-events",
  registry:    "/v1/registry/bundle",
  terminal:    "/v1/terminal/bundle",
};

export async function GET(request: NextRequest) {
  const timing = new ServerTiming();
  try {
    if (request.nextUrl.searchParams.get("resource") === "movements") {
      const params = request.nextUrl.searchParams;
      const queryParams = new URLSearchParams(params.toString());
      queryParams.delete("resource");
      const page = await callPythonApi(`/v1/movements?${queryParams.toString()}`, "GET");
      return response({ ...page, items: page.items.map(normalizeDashboardMovement), chartItems: page.chartItems.map(normalizeDashboardMovement) }, timing);
    }

    const rawScope = request.nextUrl.searchParams.get("scope") ?? "all";
    const scope = DATA_SCOPES.has(rawScope as DataScope) ? (rawScope as DataScope) : "all";

    const endpoint = SCOPE_TO_ENDPOINT[scope] ?? "/v1/dashboard";
    const raw = await callPythonApi(endpoint, "GET");

    let snapshot;
    switch (scope) {
      case "alerts":      snapshot = normalizeAlertsSnapshot(raw);      break;
      case "permissions": snapshot = normalizePermissionsSnapshot(raw); break;
      case "logs":        snapshot = normalizeLogsSnapshot(raw);        break;
      case "registry":    snapshot = normalizeRegistrySnapshot(raw);    break;
      case "terminal":    snapshot = normalizeTerminalSnapshot(raw);    break;
      default:            snapshot = normalizeDashboardSnapshot(raw);   break;
    }

    return response(snapshot, timing);
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : "Unable to load application data.",
      timing,
      error instanceof PythonApiError ? error.status : 500
    );
  }
}

export async function POST(request: NextRequest) {
  const timing = new ServerTiming();
  try {
    const parseStartedAt = performance.now();
    const body = requireObject(await request.json(), "Command");
    timing.add("request_parse", performance.now() - parseStartedAt);
    const action = requireString(body.action, "Command action");
    const send = <T,>(data: T) => response(data, timing);

    switch (action) {
      case "createTemporaryVisitor": {
        const input = requireObject(body.input, "Visitor input") as CreateTemporaryVisitorInput;
        const result = await callPythonApi('/v1/registry/subjects', 'POST', {
            barcode: input.barcode,
            kind: "visitor",
            data: input
        });
        return send({ id: result.id, barcode: result.barcode, type: "visitor", ...result.data });
      }
      case "createEmployee": {
        const input = requireObject(body.input, "Employee input") as CreateEmployeeInput;
        const result = await callPythonApi('/v1/registry/subjects', 'POST', {
            barcode: input.barcode,
            kind: "employee",
            data: input
        });
        return send({ id: result.id, barcode: result.barcode, type: "employee", ...result.data });
      }
      case "createHardwareAsset": {
        const input = requireObject(body.input, "Hardware input") as CreateHardwareAssetInput;
        const result = await callPythonApi('/v1/registry/subjects', 'POST', {
            barcode: input.barcode,
            kind: "hardware",
            data: input
        });
        return send({ id: result.id, barcode: result.barcode, type: "hardware", ...result.data });
      }
      case "updatePerson": {
        const personId = requireString(body.personId, "Person id");
        const patch = requireObject(body.patch, "Person patch") as Partial<Omit<Person, "id">>;
        const payload: any = { data: patch };
        if (patch.barcode) {
            payload.barcode = patch.barcode;
            delete payload.data.barcode;
        }
        const result = await callPythonApi(`/v1/registry/subjects/${personId}`, 'PUT', payload);
        return send({ id: result.id, barcode: result.barcode, type: result.kind, ...result.data });
      }
      case "updateHardwareAsset": {
        const assetId = requireString(body.assetId, "Asset id");
        const patch = requireObject(body.patch, "Hardware patch") as Partial<Omit<HardwareAsset, "id">>;
        const payload: any = { data: patch };
        if (patch.barcode) {
            payload.barcode = patch.barcode;
            delete payload.data.barcode;
        }
        const result = await callPythonApi(`/v1/registry/subjects/${assetId}`, 'PUT', payload);
        return send({ id: result.id, barcode: result.barcode, type: "hardware", ...result.data });
      }
      case "updateAlert":
        return send(await callPythonApi('/v1/alerts/' + body.alertId, 'PATCH', body.patch));
      case "updateAccessPermission": {
        const input = requireObject(body.input, "Permission input") as UpdateAccessPermissionInput;
        return send(await callPythonApi('/v1/permissions/' + input.subjectId, 'PATCH', input));
      }
      case "submitPermissionRequest": {
        const input = requireObject(body.request, "Request input");
        // Forward to Python backend
        const pyRes = await callPythonApi('/v1/permission-requests', 'POST', {
          subject_id: requireString(input.subjectId, "Subject id"),
          checkpoint_id: input.checkpointId || "unknown",
          request_type: requireString(input.type, "Type"),
          reason: requireString(input.purpose, "Purpose")
        });
        return send(pyRes);
      }

      case "decidePermissionRequest": {
        const decision = requireString(body.decision, "Decision");
        if (decision !== "approved" && decision !== "denied") {
          throw new Error("Decision must be approved or denied.");
        }
        const reqId = requireString(body.requestId, "Request id");
        // Forward to Python backend
        const pyRes = await callPythonApi(`/v1/permission-requests/${reqId}/decide`, 'POST', {
          decision: decision,
          reason: requireString(body.reason, "Decision reason"),
          admin_id: "admin-1"
        });
        return send({ request: pyRes });
      }
      case "updateAlertRule":
        if (typeof body.enabled !== "boolean") {
          throw new Error("Alert rule enabled state is required.");
        }
        return send(await callPythonApi('/v1/alert-rules/' + body.ruleId, 'PATCH', { enabled: body.enabled }));
      case "markNotificationRead":
        return send(await callPythonApi('/v1/notifications/' + body.notificationId + '/read', 'PATCH', {}));
      case "recordScan":
        return send(await callPythonApi('/v1/terminal/scans', 'POST', body.input, request.headers.get('Idempotency-Key') ?? crypto.randomUUID()));
      case "requestBarcodeManualReview":
        return send(await callPythonApi('/v1/terminal/manual-reviews', 'POST', body.input));
      case "saveMovement":
        {
        const event = requireObject(body.event, "Movement event");
        const saved = await callPythonApi('/v1/movements/save', 'POST', {
          id: event.id, subject_id: event.subjectId, checkpoint_id: event.checkpointId,
          occurred_at: event.createdAt, result: event.result, direction: event.direction,
          scan_type: event.scanType, subject_type: event.subjectType, sync_state: event.syncState,
          denial_code: event.denialCode, data: event,
        });
        return send(normalizeDashboardMovement(saved));
      }
      case "syncMovements":
        return send(await callPythonApi('/v1/movements/sync', 'POST', { eventIds: body.eventIds || [] }));
      case "resolveMovementConflicts":
        return send(await callPythonApi('/v1/movements/conflicts/resolve', 'POST', { eventIds: body.eventIds || [] }));
      case "addMovementNote":
        return send(await callPythonApi('/v1/movements/' + body.eventId + '/notes', 'POST', { note: body.note }));
      default:
        return errorResponse(
          `Unsupported command: ${action}.`,
          timing,
          400
        );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Command failed.";
    const conflict =
      message.includes("already assigned") ||
      message.includes("already exists");
    return errorResponse(message, timing, error instanceof PythonApiError ? error.status : conflict ? 409 : 400);
  }
}
