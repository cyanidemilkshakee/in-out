"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { PermissionRequest, Person } from "../../../../lib/types";
import { formatFacilityZones } from "../../../../lib/facilityZones";
import { formatRequestDate, REQUEST_LABELS } from "./requestPresentation";
import { EmployeeStatusLabel } from "../EmployeeStatusLabel";

type RegistrySortKey = "type" | "subjectName" | "checkpoint" | "access" | "status" | "decidedAt" | "notes";

export function AcknowledgedPermissionRequestsTable({ permissions, people }: {
  permissions: PermissionRequest[];
  people: Person[];
}) {
  const [sortKey, setSortKey] = useState<RegistrySortKey>("decidedAt");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const employeeStatuses = new Map(people.filter((person) => person.type === "employee").map((person) => [person.id, person.status] as const));
  const sortedPermissions = useMemo(() => {
    const valueFor = (permission: PermissionRequest, key: RegistrySortKey) => {
      switch (key) {
        case "type": return REQUEST_LABELS[permission.type];
        case "subjectName": return permission.subjectName;
        case "checkpoint": return permission.checkpoint || "";
        case "access": return permission.type === "hardware_custody"
          ? `${permission.previousCarrierName || "Unassigned"} ${permission.carrierName || "Unassigned"}`
          : formatFacilityZones(permission.requestedZones) || "Reviewed movement";
        case "status": return permission.status;
        case "decidedAt": {
          const value = permission.decidedAt || permission.createdAt;
          return Date.parse(value) || 0;
        }
        case "notes": return permission.decisionReason || permission.operatorNote || "";
      }
    };

    return [...permissions].sort((left, right) => {
      const leftValue = valueFor(left, sortKey);
      const rightValue = valueFor(right, sortKey);
      const comparison = typeof leftValue === "number"
        ? leftValue - Number(rightValue)
        : String(leftValue).localeCompare(String(rightValue));
      return sortDirection === "asc" ? comparison : -comparison;
    });
  }, [permissions, sortDirection, sortKey]);

  function sortHeader(column: RegistrySortKey, label: string, className: string = column) {
    const active = sortKey === column;
    return (
      <th
        className={`column-${className}`}
        aria-sort={active ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}
      >
        <button
          className="sort-button"
          type="button"
          onClick={() => {
            setSortDirection(active && sortDirection === "asc" ? "desc" : "asc");
            setSortKey(column);
          }}
        >
          <span>{label}</span>
          {active
            ? sortDirection === "asc"
              ? <ArrowUp size={16} />
              : <ArrowDown size={16} />
            : <ArrowUpDown size={16} />}
        </button>
      </th>
    );
  }

  return (
    <div className="admin-table-wrap table-wrap">
      <table className="data-table registry-table registry-table--permissions">
        <caption className="sr-only">Permission requests and decisions</caption>
        <thead>
          <tr>
            {sortHeader("type", "Permission")}
            {sortHeader("subjectName", "Subject", "subject")}
            {sortHeader("checkpoint", "Checkpoint")}
            {sortHeader("access", "Access or custody")}
            {sortHeader("status", "Decision")}
            {sortHeader("decidedAt", "Decided")}
            {sortHeader("notes", "Notes")}
          </tr>
        </thead>
        <tbody>
          {sortedPermissions.length ? sortedPermissions.map((permission) => {
            const accessDescription = permission.type === "hardware_custody"
              ? `${permission.previousCarrierName || "Unassigned"} → ${permission.carrierName || "Unassigned"}`
              : formatFacilityZones(permission.requestedZones) || "Reviewed movement";
            const decidedAt = permission.decidedAt || permission.createdAt;
            const notes = [
              permission.operatorNote ? `Operator: ${permission.operatorNote}` : null,
              `Admin: ${permission.decisionReason || "No note"}`,
            ].filter(Boolean).join("\n");

            return (
              <tr key={permission.id}>
                <td className="column-type" data-label="Permission">
                  <span className={`registry-permission-cell__primary${permission.type === "manual_override" ? " registry-permission-cell__primary--manual-review" : ""}`}>{REQUEST_LABELS[permission.type]}</span>
                </td>
                <td className="column-subject" data-label="Subject">
                  <span className="registry-permission-cell__primary" title={permission.subjectName}>{permission.subjectName}</span>
                  {employeeStatuses.has(permission.subjectId) && " "}
                  <EmployeeStatusLabel status={employeeStatuses.get(permission.subjectId)} />
                  <span className="registry-permission-cell__secondary" title={permission.barcode || "—"}>{permission.barcode || "—"}</span>
                </td>
                <td className="column-checkpoint" data-label="Checkpoint">
                  <span className="registry-permission-cell__truncate" title={permission.checkpoint || "—"}>{permission.checkpoint || "—"}</span>
                </td>
                <td className="column-access" data-label="Access or custody">
                  <span className="registry-permission-cell__truncate" title={accessDescription}>{accessDescription}</span>
                </td>
                <td className="column-status" data-label="Decision">
                  <span className={`registry-presence ${permission.status === "approved" ? "is-inside" : "is-outside"}`}>
                    {permission.status === "approved" ? "Approved" : "Denied"}
                  </span>
                </td>
                <td className="column-decidedAt" data-label="Decided">
                  <time className="registry-permission-cell__truncate" dateTime={decidedAt} title={formatRequestDate(decidedAt)}>
                    {formatRequestDate(decidedAt)}
                  </time>
                </td>
                <td className="column-notes" data-label="Notes">
                  <span className="registry-permission-cell__note" title={notes}>
                    {permission.operatorNote ? `Operator: ${permission.operatorNote}` : "Operator: —"}
                  </span>
                  <span className="registry-permission-cell__note" title={notes}>
                    Admin: {permission.decisionReason || "No note"}
                  </span>
                </td>
              </tr>
            );
          }) : <tr><td colSpan={7}>No acknowledged permission requests match this search.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
