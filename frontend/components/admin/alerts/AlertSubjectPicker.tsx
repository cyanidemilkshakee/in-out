"use client";

import { useId } from "react";
import type { Person } from "../../../../lib/types";
import styles from "./EmployeeAlertManagement.module.css";

export type AlertSubjectOption = {
  subjectId: string;
  subjectName: string;
  barcode: string;
  subjectType: Extract<Person["type"], "employee" | "visitor">;
  status?: Person["status"];
};

export function AlertSubjectPicker({ subjects, selectedId, onSelect, search, onSearch, total, isSearching = false, disabled = false }: {
  subjects: AlertSubjectOption[];
  selectedId: string;
  onSelect: (id: string) => void;
  search?: string;
  onSearch?: (value: string) => void;
  total?: number;
  isSearching?: boolean;
  disabled?: boolean;
}) {
  const selectId = useId();
  return <div className={styles.employeeField}>
    <label htmlFor={selectId}>Person</label>
    {onSearch && <input type="search" aria-label="Search people by name or barcode" maxLength={200} placeholder="Search name or barcode" value={search ?? ""} onChange={(event) => onSearch(event.target.value)} />}
    <select id={selectId} value={selectedId} disabled={disabled} onChange={(event) => onSelect(event.target.value)} aria-busy={isSearching}>
      <option value="">Select a person</option>
      {subjects.map((subject) => <option key={subject.subjectId} value={subject.subjectId}>{subject.subjectName}{subject.subjectType === "visitor" ? " · Visitor" : ""} · {subject.barcode}{subject.status ? ` · ${subject.status === "active" ? "Active" : "Inactive"}` : ""}</option>)}
    </select>
    {onSearch && <small role="status">{isSearching ? "Searching…" : total !== undefined && total > 25 ? `Showing up to 25 of ${total} people. Refine your search.` : ""}</small>}
  </div>;
}
