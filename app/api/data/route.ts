import { NextRequest, NextResponse } from "next/server";
import type {
  Alert,
  HardwareAsset,
  MovementEvent,
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
import {
  addMovementNote,
  decidePermissionRequest,
  submitPermissionRequest,
  getSnapshot,
  markNotificationRead,
  queryMovements,
  recordScan,
  resolveMovementConflicts,
  saveMovement,
  syncMovements,
  updateAccessPermission,
  updateAlert,
  updateAlertRule,
} from "../../../backend/dataRepository";
import { ServerTiming } from "../../../backend/timing";

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

async function callPythonApi(path: string, method: string, body?: any) {
  const base = process.env.PYTHON_API_URL ?? 'http://127.0.0.1:8000';
  const url = base + path;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Client-Verify": "SUCCESS",
      "X-Client-DN": "CN=dev-terminal,O=local",
      "Idempotency-Key": crypto.randomUUID()
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    throw new Error(errorBody.detail || 'Python Backend Error');
  }
  return res.json();
}

export async function GET(request: NextRequest) {
  const timing = new ServerTiming();
  try {
    if (request.nextUrl.searchParams.get("resource") === "movements") {
      const params = request.nextUrl.searchParams;
      const result = params.get("result");
      const scanType = params.get("scanType");
      const direction = params.get("direction");
      const subjectGroup = params.get("subjectGroup");
      const sortDirection = params.get("sortDirection");
      const query: MovementQuery = {
        page: Number(params.get("page") ?? 1),
        pageSize: Number(params.get("pageSize") ?? 25),
        search: params.get("search") ?? undefined,
        checkpoint: params.get("checkpoint") ?? undefined,
        result:
          result === "approved" || result === "denied" ? result : undefined,
        scanType:
          scanType === "auto" || scanType === "manual" ? scanType : undefined,
        direction:
          direction === "entry" || direction === "exit" ? direction : undefined,
        subjectGroup:
          subjectGroup === "people" || subjectGroup === "hardware"
            ? subjectGroup
            : undefined,
        startAt: params.get("startAt") ?? undefined,
        endAt: params.get("endAt") ?? undefined,
        sortKey: (params.get("sortKey") ?? undefined) as
          | VisibleColumn
          | undefined,
        sortDirection:
          sortDirection === "asc" || sortDirection === "desc"
            ? (sortDirection as SortDirection)
            : undefined,
      };
      return response(await queryMovements(query, timing.add), timing);
    }
    const rawScope = request.nextUrl.searchParams.get("scope") ?? "all";
    const scope = DATA_SCOPES.has(rawScope as DataScope)
      ? (rawScope as DataScope)
      : "all";
    return response(await getSnapshot(scope, timing.add), timing);
  } catch (error) {
    return errorResponse(
      error instanceof Error
        ? error.message
        : "Unable to load application data.",
      timing,
      500
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
        return send(
          await updateAlert(
            requireString(body.alertId, "Alert id"),
            requireObject(body.patch, "Alert patch") as Partial<Omit<Alert, "id">>
          )
        );
      case "updateAccessPermission":
        return send(
          await updateAccessPermission(
            requireObject(
              body.input,
              "Permission input"
            ) as UpdateAccessPermissionInput
          )
        );
      
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
        return send(
          await updateAlertRule(
            requireString(body.ruleId, "Rule id"),
            body.enabled
          )
        );
      case "markNotificationRead":
        return send(
          await markNotificationRead(
            requireString(body.notificationId, "Notification id")
          )
        );
      case "recordScan":
        return send(
          await recordScan(
            requireObject(body.input, "Scan input") as RecordScanInput,
            timing.add
          )
        );
      case "saveMovement":
        return send(
          await saveMovement(
            requireObject(body.event, "Movement event") as MovementEvent
          )
        );
      case "syncMovements":
        return send(
          await syncMovements(
            Array.isArray(body.eventIds)
              ? body.eventIds.filter((id): id is string => typeof id === "string")
              : undefined
          )
        );
      case "resolveMovementConflicts":
        return send(
          await resolveMovementConflicts(
            Array.isArray(body.eventIds)
              ? body.eventIds.filter((id): id is string => typeof id === "string")
              : []
          )
        );
      case "addMovementNote":
        return send(
          await addMovementNote(
            requireString(body.eventId, "Movement id"),
            requireString(body.note, "Movement note")
          )
        );
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
    return errorResponse(message, timing, conflict ? 409 : 400);
  }
}
