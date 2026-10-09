"use client";

import type { Person } from "../../../../lib/types";
import styles from "./EmployeeAlertManagement.module.css";

export type AlertSubjectOption = { subjectId: string; subjectName: string; barcode: string; status?: Person["status"] };

export function AlertSubjectPicker({ subjects, selectedId, onSelect, disabled = false }: {
  subjects: AlertSubjectOption[];
  selectedId: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  return <label className={styles.employeeField}>
    <span>Employee</span>
    <select value={selectedId} disabled={disabled} onChange={(event) => onSelect(event.target.value)}>
      <option value="">Select an employee</option>
      {subjects.map((subject) => <option key={subject.subjectId} value={subject.subjectId}>{subject.subjectName} · {subject.barcode}{subject.status ? ` · ${subject.status === "active" ? "Active" : "Inactive"}` : ""}</option>)}
    </select>
  </label>;
}
