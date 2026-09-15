import type { NextRequest } from "next/server";
import type {
  CreateEmployeeInput,
  CreateHardwareAssetInput,
  CreateTemporaryVisitorInput,
  HardwareAsset,
  Person,
  UpdateAccessPermissionInput,
} from "../../../lib/types";
import { normalizeDashboardMovement } from "../../../lib/normalizeDashboard";
import { callPythonApi } from "../pythonApi";
import {
  requireObject,
  requireString,
  response,
  type ServerTiming,
} from "./bff";

export async function executeCommand(
  action: string,
  body: Record<string, unknown>,
  request: NextRequest,
  timing: ServerTiming
) {
  const send = <T,>(data: T) => response(data, timing);

  switch (action) {
    case "createTemporaryVisitor": {
      const input = requireObject(body.input, "Visitor input") as CreateTemporaryVisitorInput;
      const result = await callPythonApi("/v1/registry/subjects", "POST", {
        barcode: input.barcode,
        kind: "visitor",
        data: input,
      });
      return send({ id: result.id, barcode: result.barcode, type: "visitor", ...result.data });
    }
    case "createEmployee": {
      const input = requireObject(body.input, "Employee input") as CreateEmployeeInput;
      const result = await callPythonApi("/v1/registry/subjects", "POST", {
        barcode: input.barcode,
        kind: "employee",
        data: input,
      });
      return send({ id: result.id, barcode: result.barcode, type: "employee", ...result.data });
    }
    case "createHardwareAsset": {
      const input = requireObject(body.input, "Hardware input") as CreateHardwareAssetInput;
      const result = await callPythonApi("/v1/registry/subjects", "POST", {
        barcode: input.barcode,
        kind: "hardware",
        data: input,
      });
      return send({ id: result.id, barcode: result.barcode, type: "hardware", ...result.data });
    }
    case "updatePerson": {
      const personId = requireString(body.personId, "Person id");
      const patch = requireObject(body.patch, "Person patch") as Partial<Omit<Person, "id">>;
      const payload = { data: { ...patch } } as { data: Partial<Omit<Person, "id">>; barcode?: string };
      if (patch.barcode) {
        payload.barcode = patch.barcode;
        delete payload.data.barcode;
      }
      const result = await callPythonApi(`/v1/registry/subjects/${personId}`, "PUT", payload);
      return send({ id: result.id, barcode: result.barcode, type: result.kind, ...result.data });
    }
    case "updateHardwareAsset": {
      const assetId = requireString(body.assetId, "Asset id");
      const patch = requireObject(body.patch, "Hardware patch") as Partial<Omit<HardwareAsset, "id">>;
      const payload = { data: { ...patch } } as { data: Partial<Omit<HardwareAsset, "id">>; barcode?: string };
      if (patch.barcode) {
        payload.barcode = patch.barcode;
        delete payload.data.barcode;
      }
      const result = await callPythonApi(`/v1/registry/subjects/${assetId}`, "PUT", payload);
      return send({ id: result.id, barcode: result.barcode, type: "hardware", ...result.data });
    }
    case "updateAlert":
      return send(await callPythonApi(`/v1/alerts/${requireString(body.alertId, "Alert id")}`, "PATCH", requireObject(body.patch, "Alert patch")));
    case "updateAccessPermission": {
      const input = requireObject(body.input, "Permission input") as UpdateAccessPermissionInput;
      return send(await callPythonApi(`/v1/permissions/${input.subjectId}`, "PATCH", input));
    }
    case "submitPermissionRequest": {
      const input = requireObject(body.request, "Request input");
      return send(await callPythonApi("/v1/permission-requests", "POST", {
        subject_id: requireString(input.subjectId, "Subject id"),
        checkpoint_id: input.checkpointId || "main-gate",
        request_type: requireString(input.type, "Type"),
        reason: requireString(input.purpose, "Purpose"),
        subject_name: input.subjectName,
        barcode: input.barcode,
        requester: input.requester,
        requested_zones: input.requestedZones,
        valid_from: input.validFrom,
        valid_to: input.validTo,
        hardware_id: input.hardwareId,
        carrier_id: input.carrierId,
        carrier_name: input.carrierName,
        event_id: input.eventId,
        direction: input.direction,
      }));
    }
    case "decidePermissionRequest": {
      const decision = requireString(body.decision, "Decision");
      if (decision !== "approved" && decision !== "denied") {
        throw new Error("Decision must be approved or denied.");
      }
      const requestId = requireString(body.requestId, "Request id");
      return send(await callPythonApi(`/v1/permission-requests/${requestId}/decide`, "POST", {
        decision,
        reason: requireString(body.reason, "Decision reason"),
        admin_id: "admin-1",
      }));
    }
    case "updateAlertRule": {
      const ruleId = requireString(body.ruleId, "Rule id");
      if (typeof body.enabled !== "boolean") throw new Error("Alert rule enabled state is required.");
      return send(await callPythonApi(`/v1/alert-rules/${ruleId}`, "PATCH", { enabled: body.enabled }));
    }
    case "markNotificationRead":
      return send(await callPythonApi(`/v1/notifications/${requireString(body.notificationId, "Notification id")}/read`, "PATCH", {}));
    case "recordScan":
      return send(await callPythonApi(
        "/v1/terminal/scans",
        "POST",
        requireObject(body.input, "Scan input"),
        request.headers.get("Idempotency-Key") ?? crypto.randomUUID()
      ));
    case "requestBarcodeManualReview":
      return send(await callPythonApi("/v1/terminal/manual-reviews", "POST", requireObject(body.input, "Manual review input")));
    case "saveMovement": {
      const event = requireObject(body.event, "Movement event");
      const saved = await callPythonApi("/v1/movements/save", "POST", {
        id: event.id,
        subject_id: event.subjectId,
        checkpoint_id: event.checkpointId,
        occurred_at: event.createdAt,
        result: event.result,
        direction: event.direction,
        scan_type: event.scanType,
        subject_type: event.subjectType,
        sync_state: event.syncState,
        denial_code: event.denialCode,
        data: event,
      });
      return send(normalizeDashboardMovement(saved));
    }
    case "syncMovements":
      return send(await callPythonApi("/v1/movements/sync", "POST", { eventIds: body.eventIds || [] }));
    case "resolveMovementConflicts":
      return send(await callPythonApi("/v1/movements/conflicts/resolve", "POST", { eventIds: body.eventIds || [] }));
    case "addMovementNote":
      return send(await callPythonApi(`/v1/movements/${requireString(body.eventId, "Event id")}/notes`, "POST", { note: body.note }));
    default:
      throw new Error(`Unsupported command: ${action}.`);
  }
}
