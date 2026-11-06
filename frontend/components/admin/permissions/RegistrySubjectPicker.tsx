"use client";

import { useEffect, useState } from "react";
import { useDataActions } from "../../../context/DataContext";
import type { HardwareAsset, Person, RegistrySubjectQuery } from "../../../../lib/types";

type Subject = Person | HardwareAsset;

/** Keep permission forms searchable without embedding the entire registry. */
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
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [items, setItems] = useState<Subject[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setPage(0); setSearch(""); }, [kind]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError("");
      void queryRegistrySubjects({ kind, search: search.trim() || undefined, limit: 25, offset: page * 25 }, controller.signal)
        .then(result => {
          if (controller.signal.aborted) return;
          setItems(result.items.filter(item => item.name.trim().toLowerCase() !== "unregistered barcode"));
          setTotal(result.total);
        })
        .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load registry records."); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, search ? 200 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [kind, page, queryRegistrySubjects, search]);
  const options = selected && !items.some(item => item.id === selected.id) ? [selected, ...items] : items;
  return <>
    <input className="admin-surface" type="search" aria-label={`Search ${label.toLowerCase()}`} maxLength={200}
      value={search} disabled={disabled} placeholder="Search name or barcode…"
      onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }}
      onChange={event => { setSearch(event.target.value); setPage(0); }} />
    <select className="admin-surface" aria-label={label} aria-invalid={invalid || undefined} required value={value}
      disabled={disabled || (loading && !options.length)} onChange={event => onChange(options.find(item => item.id === event.target.value))}>
      <option value="">Choose {label.toLowerCase()}</option>
      {options.map(item => <option key={item.id} value={item.id}>{item.name} · {item.barcode}</option>)}
    </select>
    {error ? <span role="alert">{error}</span> : null}
    {total > 25 ? <span className="pagination">
      <button type="button" disabled={disabled || loading || page === 0} onClick={() => setPage(current => current - 1)}>Previous</button>
      <span>{page + 1} / {Math.ceil(total / 25)}</span>
      <button type="button" disabled={disabled || loading || (page + 1) * 25 >= total} onClick={() => setPage(current => current + 1)}>Next</button>
    </span> : null}
  </>;
}
