"use client";

import { useMemo, useState } from "react";
import type { Alert, AlertRule, AlertRuleAssignment, AlertWarningSummary, Person } from "../../../../lib/types";
import { AlertSubjectPicker, type AlertSubjectOption } from "./AlertSubjectPicker";
import { RuleAssignments } from "./RuleAssignments";
import { WarningSummary } from "./WarningSummary";
import styles from "./EmployeeAlertManagement.module.css";

export function EmployeeAlertManagement({ assignments, warnings, alerts, rules, people, onReset, onSave, onReload, isLoading = false }: {
  assignments: AlertRuleAssignment[];
  warnings: AlertWarningSummary[];
  alerts: Alert[];
  rules: AlertRule[];
  people: Person[];
  onReset: (subjectId: string, reason: string) => Promise<void>;
  onSave: (subjectId: string, ruleIds: string[], irregularitySkipDates: string[], expectedRevision: number) => Promise<void>;
  onReload: () => Promise<void>;
  isLoading?: boolean;
}) {
  const [selectedEmployeeId, setSelectedEmployeeId] = useState("");
  const employees = useMemo(() => {
    const employeeStatuses = new Map(people.filter((person) => person.type === "employee").map((person) => [person.id, person.status] as const));
    const byId = new Map<string, AlertSubjectOption>();
    assignments.filter((item) => item.subjectType === "employee").forEach((item) => {
      byId.set(item.subjectId, { subjectId: item.subjectId, subjectName: item.subjectName, barcode: item.barcode, status: employeeStatuses.get(item.subjectId) });
    });
    warnings.filter((item) => item.subjectType === "employee").forEach((item) => {
      if (!byId.has(item.subjectId)) byId.set(item.subjectId, { subjectId: item.subjectId, subjectName: item.subjectName, barcode: item.barcode, status: employeeStatuses.get(item.subjectId) });
    });
    return [...byId.values()].sort((left, right) => left.subjectName.localeCompare(right.subjectName));
  }, [assignments, people, warnings]);
  const selectedEmployee = employees.find((employee) => employee.subjectId === selectedEmployeeId);

  return <section className={styles.panel} aria-labelledby="alert-employee-rules-title">
    <header className={styles.header}>
      <h2 id="alert-employee-rules-title">Employee warnings &amp; rules</h2>
    </header>
    <div className={styles.selector}>
      <AlertSubjectPicker subjects={employees} selectedId={selectedEmployeeId} onSelect={setSelectedEmployeeId} disabled={isLoading} />
    </div>
    {selectedEmployee ? <div className={styles.sections}>
      <RuleAssignments assignments={assignments} rules={rules} selectedEmployeeId={selectedEmployeeId} onSave={onSave} onReload={onReload} isLoading={isLoading}>
        <WarningSummary alerts={alerts} warnings={warnings} selectedEmployee={selectedEmployee} onReset={onReset} isLoading={isLoading} />
      </RuleAssignments>
    </div> : <div className={styles.sections}>
      {isLoading ? <p className={styles.empty}>Loading employee alert data…</p> : !employees.length ? <p className={styles.empty}>No employees are available.</p> : null}
    </div>}
  </section>;
}
