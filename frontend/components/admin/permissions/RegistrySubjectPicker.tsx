"use client";

import { useEffect, useState } from "react";
import { useDataActions } from "../../../context/DataContext";
import type { HardwareAsset, Person, RegistrySubjectQuery } from "../../../../lib/types";

type Subject = Person | HardwareAsset;

const SUBJECT_PAGE_SIZE = 25;

/** Search and page through the scoped registry without loading the whole directory. */
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
  useEffect(() => {
    const controller = new AbortController();
    setItems([]);
    setTotal(0);
    setError("");
    setLoading(true);
    const timer = setTimeout(() => {
      void queryRegistrySubjects({ kind, search: search.trim() || undefined,
        limit: SUBJECT_PAGE_SIZE, offset: page * SUBJECT_PAGE_SIZE }, controller.signal)
        .then(result => {
          if (controller.signal.aborted) return;
          setItems(result.items.filter(item => item.name.trim().toLowerCase() !== "unregistered barcode"));
          setTotal(result.total);
        })
        .catch(cause => {
          if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load registry records.");
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, search ? 200 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [kind, page, queryRegistrySubjects, search]);
  useEffect(() => {
    setSearch("");
    setPage(0);
  }, [kind]);
  const options = selected && !items.some(item => item.id === selected.id) ? [selected, ...items] : items;
  const pageCount = Math.max(1, Math.ceil(total / SUBJECT_PAGE_SIZE));
  return <>
    <input className="admin-surface" type="search" aria-label={`Search ${label.toLowerCase()} by name or barcode`}
      placeholder={`Search ${label.toLowerCase()} by name or barcode`} maxLength={200} value={search} disabled={disabled}
      onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }}
      onChange={event => { setSearch(event.target.value); setPage(0); }} />
    <select className="admin-surface" aria-label={label} aria-invalid={invalid || undefined} required value={value}
      disabled={disabled || (loading && !options.length)} onChange={event => onChange(options.find(item => item.id === event.target.value))}>
      <option value="">{loading ? "Loading records…" : `Choose ${label.toLowerCase()}`}</option>
      {options.map(item => <option key={item.id} value={item.id}>{item.name} · {item.barcode}</option>)}
      {!loading && !options.length ? <option value="" disabled>No matching records</option> : null}
    </select>
    {loading ? <span role="status">Searching records…</span> : null}
    {error ? <span role="alert">{error}</span> : null}
    {total > SUBJECT_PAGE_SIZE ? <span className="pagination">
      <button type="button" disabled={disabled || loading || page === 0} onClick={() => setPage(current => current - 1)}>Previous</button>
      <span>{page + 1} / {pageCount}</span>
      <button type="button" disabled={disabled || loading || page + 1 >= pageCount} onClick={() => setPage(current => current + 1)}>Next</button>
    </span> : null}
  </>;
}
