"use client";

import { useEffect, useState } from "react";
import { useDataActions } from "../../../context/DataContext";
import type { Person } from "../../../../lib/types";

/** Search all employees without loading a directory into each creation form. */
export function RegistryEmployeePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { queryRegistrySubjects } = useDataActions();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [employees, setEmployees] = useState<Person[]>([]);
  const [selected, setSelected] = useState<Person | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError("");
      void queryRegistrySubjects({ kind: "employee", search: search.trim() || undefined, limit: 25, offset: page * 25 }, controller.signal)
        .then(result => { if (!controller.signal.aborted) { setEmployees(result.items as Person[]); setTotal(result.total); } })
        .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to load employees."); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, search ? 200 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [page, queryRegistrySubjects, search]);
  const options = selected && !employees.some(person => person.id === selected.id) ? [selected, ...employees] : employees;
  return <>
    <input type="search" aria-label="Search hardware owner" maxLength={200} placeholder="Search employees..." value={search}
      onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }}
      onChange={event => { setSearch(event.target.value); setPage(0); }} />
    <select aria-label="Owner" value={value} required disabled={loading && !options.length} onChange={event => {
      setSelected(options.find(person => person.id === event.target.value) ?? null);
      onChange(event.target.value);
    }}><option value="" disabled>Choose an employee</option>{options.map(person => <option key={person.id} value={person.id}>{person.name} · {person.barcode}</option>)}</select>
    {error ? <span role="alert">{error}</span> : null}
    {total > 25 ? <span className="pagination"><button type="button" disabled={page === 0 || loading} onClick={() => setPage(value => value - 1)}>Previous</button>
      <span>{page + 1} / {Math.ceil(total / 25)}</span><button type="button" disabled={loading || (page + 1) * 25 >= total} onClick={() => setPage(value => value + 1)}>Next</button></span> : null}
  </>;
}
