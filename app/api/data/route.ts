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
  createEmployee,
  createHardwareAsset,
  createTemporaryVisitor,
  decidePermissionRequest,
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
  updateHardwareAsset,
  updatePerson,
} from "../../../server/dataRepository";
import { ServerTiming } from "../../../server/timing";

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
      return response(queryMovements(query, timing.add), timing);
    }
    const rawScope = request.nextUrl.searchParams.get("scope") ?? "all";
    const scope = DATA_SCOPES.has(rawScope as DataScope)
      ? (rawScope as DataScope)
      : "all";
    return response(getSnapshot(scope, timing.add), timing);
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
      case "createTemporaryVisitor":
        return send(
          createTemporaryVisitor(
            requireObject(body.input, "Visitor input") as CreateTemporaryVisitorInput
          )
        );
      case "createEmployee":
        return send(
          createEmployee(
            requireObject(body.input, "Employee input") as CreateEmployeeInput
          )
        );
      case "createHardwareAsset":
        return send(
          createHardwareAsset(
            requireObject(body.input, "Hardware input") as CreateHardwareAssetInput
          )
        );
      case "updatePerson":
        return send(
          updatePerson(
            requireString(body.personId, "Person id"),
            requireObject(body.patch, "Person patch") as Partial<Omit<Person, "id">>
          )
        );
      case "updateHardwareAsset":
        return send(
          updateHardwareAsset(
            requireString(body.assetId, "Asset id"),
            requireObject(
              body.patch,
              "Hardware patch"
            ) as Partial<Omit<HardwareAsset, "id">>
          )
        );
      case "updateAlert":
        return send(
          updateAlert(
            requireString(body.alertId, "Alert id"),
            requireObject(body.patch, "Alert patch") as Partial<Omit<Alert, "id">>
          )
        );
      case "updateAccessPermission":
        return send(
          updateAccessPermission(
            requireObject(
              body.input,
              "Permission input"
            ) as UpdateAccessPermissionInput
          )
        );
      case "decidePermissionRequest": {
        const decision = requireString(body.decision, "Decision");
        if (decision !== "approved" && decision !== "denied") {
          throw new Error("Decision must be approved or denied.");
        }
        return send(
          decidePermissionRequest(
            requireString(body.requestId, "Request id"),
            decision,
            requireString(body.reason, "Decision reason")
          )
        );
      }
      case "updateAlertRule":
        if (typeof body.enabled !== "boolean") {
          throw new Error("Alert rule enabled state is required.");
        }
        return send(
          updateAlertRule(
            requireString(body.ruleId, "Rule id"),
            body.enabled
          )
        );
      case "markNotificationRead":
        return send(
          markNotificationRead(
            requireString(body.notificationId, "Notification id")
          )
        );
      case "recordScan":
        return send(
          recordScan(
            requireObject(body.input, "Scan input") as RecordScanInput,
            timing.add
          )
        );
      case "saveMovement":
        return send(
          saveMovement(
            requireObject(body.event, "Movement event") as MovementEvent
          )
        );
      case "syncMovements":
        return send(
          syncMovements(
            Array.isArray(body.eventIds)
              ? body.eventIds.filter((id): id is string => typeof id === "string")
              : undefined
          )
        );
      case "resolveMovementConflicts":
        return send(
          resolveMovementConflicts(
            Array.isArray(body.eventIds)
              ? body.eventIds.filter((id): id is string => typeof id === "string")
              : []
          )
        );
      case "addMovementNote":
        return send(
          addMovementNote(
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
