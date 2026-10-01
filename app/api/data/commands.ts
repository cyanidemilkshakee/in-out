import type { NextRequest } from "next/server";
import type {
  CreateEmployeeInput,
  CreateHardwareAssetInput,
  HardwareAsset,
  Person,
  UpdateAccessPermissionInput,
} from "../../../lib/types";
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
    case "acknowledgeAlert":
      return send(await callPythonApi(`/v1/alerts/${requireString(body.alertId, "Alert id")}`, "PATCH", { status: "acknowledged" }));
    case "updateAccessPermission": {
      const input = requireObject(body.input, "Permission input") as UpdateAccessPermissionInput;
      return send(await callPythonApi(`/v1/permissions/${input.subjectId}`, "PATCH", input));
    }
    case "submitPermissionRequest": {
      const input = requireObject(body.request, "Request input");
      const requestType = requireString(input.type, "Type");
      const operatorNote = requestType === "manual_override"
        ? requireString(input.operatorNote, "Request note")
        : input.operatorNote;
      return send(await callPythonApi("/v1/permission-requests", "POST", {
        subject_id: requireString(input.subjectId, "Subject id"),
        checkpoint_id: input.checkpointId || "main-gate",
        request_type: requestType,
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
        operator_note: operatorNote,
      }));
    }
    case "decidePermissionRequest": {
      const decision = requireString(body.decision, "Decision");
      if (decision !== "approved" && decision !== "denied") {
        throw new Error("Decision must be approved or denied.");
      }
      const requestId = requireString(body.requestId, "Request id");
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (decision === "denied" && !reason) {
        throw new Error("A decision note is required when denying a permission request.");
      }
      const validForMinutes = body.validForMinutes;
      if (validForMinutes !== undefined && (typeof validForMinutes !== "number" || !Number.isInteger(validForMinutes) || validForMinutes < 15 || validForMinutes > 240)) {
        throw new Error("Valid for must be between 15 minutes and 4 hours.");
      }
      return send(await callPythonApi(`/v1/permission-requests/${requestId}/decide`, "POST", {
        decision,
        reason,
        valid_for_minutes: decision === "approved" ? validForMinutes : undefined,
        admin_id: "admin-1",
      }));
    }
    case "acknowledgePermissionRequest":
      return send(await callPythonApi(
        `/v1/permission-requests/${requireString(body.requestId, "Request id")}/acknowledge`,
        "POST",
        {}
      ));
    case "updateAlertRule": {
      const ruleId = requireString(body.ruleId, "Rule id");
      if (typeof body.enabled !== "boolean") throw new Error("Alert rule enabled state is required.");
      return send(await callPythonApi(`/v1/alert-rules/${ruleId}`, "PATCH", { enabled: body.enabled }));
    }
    case "evaluateAlertRules":
      return send(await callPythonApi("/v1/alerts/evaluate", "POST"));
    case "markNotificationRead":
      return send(await callPythonApi(`/v1/notifications/${requireString(body.notificationId, "Notification id")}/read`, "PATCH", {}));
    case "recordScan":
      return send(await callPythonApi(
        "/v1/terminal/scans",
        "POST",
        requireObject(body.input, "Scan input"),
        request.headers.get("Idempotency-Key") ?? crypto.randomUUID()
      ));
    case "requestBarcodeManualReview": {
      const input = requireObject(body.input, "Manual review input");
      requireString(input.operatorNote, "Request note");
      return send(await callPythonApi("/v1/terminal/manual-reviews", "POST", input));
    }
    case "addMovementNote":
      return send(await callPythonApi(`/v1/movements/${encodeURIComponent(requireString(body.eventId, "Event id"))}/notes`, "POST", { note: body.note }));
    default:
      throw new Error(`Unsupported command: ${action}.`);
  }
}
