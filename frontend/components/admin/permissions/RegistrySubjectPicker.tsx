"use client";

import { useEffect, useState } from "react";
import { useDataActions } from "../../../context/DataContext";
import type { HardwareAsset, Person, RegistrySubjectQuery } from "../../../../lib/types";

type Subject = Person | HardwareAsset;

const SUBJECT_PAGE_SIZE = 200;

/** Load the scoped registry for a simple, complete permission dropdown. */
export function RegistrySubjectPicker({ value, selected, onChange, kind, label, disabled, invalid }: {
  value: string;
  selected?: Subject;
  onChange: (subject?: Subject) => void;
  kind?: RegistrySubjectQuery["kind"];
  label: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const { queryRegistrySubjects } = useDataActions();
  const [items, setItems] = useState<Subject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setItems([]);
    setLoading(true);
    setError("");
    void (async () => {
      const records: Subject[] = [];
      let total = Number.POSITIVE_INFINITY;
      let offset = 0;
      while (offset < total) {
        const result = await queryRegistrySubjects({ kind, limit: SUBJECT_PAGE_SIZE, offset }, controller.signal);
        if (controller.signal.aborted) return;
        records.push(...result.items.filter(item => item.name.trim().toLowerCase() !== "unregistered barcode"));
        total = result.total;
        if (!result.items.length) break;
        offset += result.items.length;
      }
      if (!controller.signal.aborted) setItems(records);
    })()
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load registry records."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [kind, queryRegistrySubjects]);
  const options = selected && !items.some(item => item.id === selected.id) ? [selected, ...items] : items;
  return <>
    <select className="admin-surface" aria-label={label} aria-invalid={invalid || undefined} required value={value}
      disabled={disabled || loading} onChange={event => onChange(options.find(item => item.id === event.target.value))}>
      <option value="">{loading ? "Loading records…" : `Choose ${label.toLowerCase()}`}</option>
      {options.map(item => <option key={item.id} value={item.id}>{item.name} · {item.barcode}</option>)}
    </select>
    {error ? <span role="alert">{error}</span> : null}
  </>;
}
