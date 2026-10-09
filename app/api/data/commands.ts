import type { NextRequest } from "next/server";
import type {
  CreateEmployeeInput,
  CreateHardwareAssetInput,
  CreateVisitorInput,
  HardwareAsset,
  Person,
} from "../../../lib/types";
import { callPythonApi } from "../pythonApi";
import {
  requireObject,
  requireString,
  response,
  type ServerTiming,
} from "./bff";
import { normalizeAccessPermission, normalizeAlert, normalizeAlertRuleAssignment, normalizeAuditEvent, normalizeDashboardMovement, normalizePermissionRequest } from "../../../lib/normalizeDashboard";
import { normalizeSubjectZones } from "../../../lib/facilityZones";
import { isManualReviewDuration } from "../../../lib/manualReviewDuration";

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
      return send(normalizeSubjectZones({ id: result.id, barcode: result.barcode, type: "employee", ...result.data }));
    }
    case "createVisitor": {
      const input = requireObject(body.input, "Visitor input") as CreateVisitorInput;
      const result = await callPythonApi("/v1/registry/subjects", "POST", {
        barcode: input.barcode,
        kind: "visitor",
        data: input,
      });
      if (!result.request) throw new Error("Visitor registration did not create a permission request.");
      return send({
        visitor: normalizeSubjectZones({ id: result.id, barcode: result.barcode, type: "visitor", ...result.data }),
        request: normalizePermissionRequest(result.request),
      });
    }
    case "createHardwareAsset": {
      const input = requireObject(body.input, "Hardware input") as CreateHardwareAssetInput;
      const result = await callPythonApi("/v1/registry/subjects", "POST", {
        barcode: input.barcode,
        kind: "hardware",
        data: input,
      });
      return send(normalizeSubjectZones({ id: result.id, barcode: result.barcode, type: "hardware", ...result.data }));
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
      return send(normalizeSubjectZones({ id: result.id, barcode: result.barcode, type: result.kind, ...result.data }));
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
      return send(normalizeSubjectZones({ id: result.id, barcode: result.barcode, type: "hardware", ...result.data }));
    }
    case "acknowledgeAlert":
      return send(await callPythonApi(`/v1/alerts/${requireString(body.alertId, "Alert id")}`, "PATCH", { status: "acknowledged" }));
    case "reviewAlert": {
      const result = await callPythonApi(`/v1/alerts/${encodeURIComponent(requireString(body.alertId, "Alert id"))}/review`, "POST", {
        decision: body.decision, reason: body.reason ?? "",
      });
      return send({ ...result, alert: normalizeAlert(result.alert) });
    }
    case "resetAlertWarnings":
      return send(await callPythonApi(`/v1/alert-warnings/${encodeURIComponent(requireString(body.subjectId, "Subject id"))}/reset`, "POST", { reason: body.reason }));
    case "setAlertRuleAssignments":
      return send(normalizeAlertRuleAssignment(await callPythonApi(`/v1/alert-rule-assignments/${encodeURIComponent(requireString(body.subjectId, "Subject id"))}`, "PUT", {
        ruleIds: body.ruleIds, irregularitySkipDates: body.irregularitySkipDates,
        ...(body.expectedRevision !== undefined ? { expectedRevision: body.expectedRevision } : {}),
      })));
    case "grantPermission": {
      const input = requireObject(body.input, "Permission input");
      const result = await callPythonApi("/v1/permissions/grant", "POST", {
        subject_id: input.newVisitor ? "" : requireString(input.subjectId, "Subject id"),
        checkpoint_id: input.checkpointId || "cp-main",
        request_type: requireString(input.type, "Permission type"),
        reason: typeof input.purpose === "string" ? input.purpose.trim() : "",
        barcode: input.barcode,
        requested_zones: input.requestedZones,
        valid_from: input.validFrom,
        valid_to: input.validTo,
        permanent_access: input.permanentAccess === true,
        hardware_id: input.hardwareId,
        carrier_id: input.carrierId,
        new_visitor: input.newVisitor,
      });
      return send({ ...result,
        request: normalizePermissionRequest(result.request),
        permission: result.permission ? normalizeAccessPermission(result.permission) : undefined,
        person: result.person ? normalizeSubjectZones(result.person) : undefined,
        hardwareAsset: result.hardwareAsset ? normalizeSubjectZones(result.hardwareAsset) : undefined,
        hardwareAssets: result.hardwareAssets?.map(normalizeSubjectZones),
        auditEvent: result.auditEvent ? normalizeAuditEvent(result.auditEvent) : undefined });
    }
    case "releaseEntryRestriction":
      return send(await callPythonApi(`/v1/alerts/${encodeURIComponent(requireString(body.alertId, "Alert id"))}/release-entry-restriction`,
        "POST", { reason: requireString(body.reason, "Reason for lifting restriction") }));
    case "submitPermissionRequest": {
      const input = requireObject(body.request, "Request input");
      const requestType = requireString(input.type, "Type");
      const operatorNote = requestType === "manual_override"
        ? requireString(input.operatorNote, "Request note")
        : input.operatorNote;
      return send(normalizePermissionRequest(await callPythonApi("/v1/permission-requests", "POST", {
        subject_id: requireString(input.subjectId, "Subject id"),
        checkpoint_id: input.checkpointId || "cp-main",
        request_type: requestType,
        reason: typeof input.purpose === "string" ? input.purpose.trim() : "",
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
      })));
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
      if (validForMinutes !== undefined && !isManualReviewDuration(validForMinutes)) {
        throw new Error("Choose 15 minutes, 30 minutes, 1 hour, 2 hours, or 4 hours for Valid for.");
      }
      const result = await callPythonApi(`/v1/permission-requests/${requestId}/decide`, "POST", {
        decision,
        reason,
        valid_for_minutes: decision === "approved" ? validForMinutes : undefined,
        admin_id: "admin-1",
      });
      return send({ ...result,
        request: normalizePermissionRequest(result.request),
        permission: result.permission ? normalizeAccessPermission(result.permission) : undefined,
        person: result.person ? normalizeSubjectZones(result.person) : undefined,
        hardwareAsset: result.hardwareAsset ? normalizeSubjectZones(result.hardwareAsset) : undefined,
        hardwareAssets: result.hardwareAssets?.map(normalizeSubjectZones),
        movement: result.movement ? normalizeDashboardMovement(result.movement) : undefined,
        auditEvent: result.auditEvent ? normalizeAuditEvent(result.auditEvent) : undefined });
    }
    case "dismissPermissionNotification":
      return send(normalizePermissionRequest(await callPythonApi(
        `/v1/permission-requests/${requireString(body.requestId, "Request id")}/dismiss`,
        "POST",
        {}
      )));
    case "evaluateAlertRules":
      return send(await callPythonApi("/v1/alerts/evaluate", "POST"));
    case "recordScan": {
      const result = await callPythonApi(
        "/v1/terminal/scans",
        "POST",
        requireObject(body.input, "Scan input"),
        request.headers.get("Idempotency-Key") ?? crypto.randomUUID()
      );
      return send({ ...result,
        decision: { ...result.decision, event: normalizeDashboardMovement(result.decision.event),
          subject: result.decision.subject ? normalizeSubjectZones(result.decision.subject) : undefined,
          carriedHardware: result.decision.carriedHardware?.map(normalizeSubjectZones) ?? [] },
        updatedPeople: result.updatedPeople?.map(normalizeSubjectZones) ?? [],
        updatedHardwareAssets: result.updatedHardwareAssets?.map(normalizeSubjectZones) ?? [],
        manualApprovalRequest: result.manualApprovalRequest
          ? normalizePermissionRequest(result.manualApprovalRequest)
          : undefined,
      });
    }
    case "requestBarcodeManualReview": {
      const input = requireObject(body.input, "Manual review input");
      requireString(input.operatorNote, "Request note");
      return send(normalizePermissionRequest(await callPythonApi("/v1/terminal/manual-reviews", "POST", input)));
    }
    case "addMovementNote":
      return send(await callPythonApi(`/v1/movements/${encodeURIComponent(requireString(body.eventId, "Event id"))}/notes`, "POST", { note: body.note }));
    default:
      throw new Error(`Unsupported command: ${action}.`);
  }
}
