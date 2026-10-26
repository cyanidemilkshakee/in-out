import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { Person, RegistrySortKey, SortDirection } from '../../../../lib/types';
import Link from 'next/link';
import { useDateTimeNow } from '../../../hooks/useDateTimeNow';
import { PERSON_STATUS_LABELS } from '../../../../lib/personStatus';

function visitorStatus(person: Person, now: number): Person["status"] {
  if (person.status === "pending_approval") return "pending_approval";
  const validTo = person.validTo ? Date.parse(person.validTo) : Number.NaN;
  if (person.status === "expired" || (Number.isFinite(validTo) && validTo <= now)) return "expired";
  if (person.status === "active" || person.status === "pre_approved") return "pre_approved";
  return person.status;
}

export function PeopleTable({
  title,
  people: rows,
  sort,
}: {
  title: string;
  people: Person[];
  sort?: { key: RegistrySortKey; direction: SortDirection; onChange: (key: RegistrySortKey) => void };
}) {
  const [localSortKey, setSortKey] = useState<keyof Person>("name");
  const [localSortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const sortKey = sort?.key ?? localSortKey;
  const sortDirection = sort?.direction ?? localSortDirection;
  const now = useDateTimeNow().getTime();
  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      if (sort) return 0;
      if (sortKey === "status") {
        const comparison = PERSON_STATUS_LABELS[visitorStatus(a, now)].localeCompare(PERSON_STATUS_LABELS[visitorStatus(b, now)]);
        return sortDirection === "asc" ? comparison : -comparison;
      }
      const comparison = sortKey === "createdAt" || sortKey === "validTo"
        ? (Date.parse(String(a[sortKey] ?? "")) || 0) - (Date.parse(String(b[sortKey] ?? "")) || 0)
        : String(a[sortKey as keyof Person] ?? "").localeCompare(String(b[sortKey as keyof Person] ?? ""));
      return sortDirection === "asc" ? comparison : -comparison;
    });
  }, [now, rows, sortDirection, sortKey, sort]);

  function sortHeader(column: keyof Person, label: string) {
    const active = sortKey === column;
    return (
      <th
        className={`column-${String(column)}`}
        aria-sort={active ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}
      >
        <button
          className="sort-button"
          type="button"
          onClick={() => {
            if (sort) { sort.onChange(column as RegistrySortKey); return; }
            setSortDirection(active && sortDirection === "asc" ? "desc" : "asc");
            setSortKey(column);
          }}
        >
          <span>{label}</span>
          {active ? (sortDirection === "asc" ? <ArrowUp size={16} /> : <ArrowDown size={16} />) : <ArrowUpDown size={16} />}
        </button>
      </th>
    );
  }

  return (
      <div className="admin-table-wrap table-wrap scrollable-content">
        <table className="data-table people-table registry-table registry-table--people">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              {sortHeader("name", "Name")}
              {sortHeader("createdAt", "Created At")}
              {sortHeader("barcode", "Barcode")}
              {sortHeader("company", "Company")}
              {sortHeader("host", "Host")}
              {sortHeader("validTo", "Valid until")}
              {sortHeader("status", "Status")}
              {sortHeader("inside", "Inside")}
              <th scope="col">Requests</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((person) => {
              const status = visitorStatus(person, now);
              return (
                <tr key={person.id}>
                  <td className="column-name" data-label="Name">{person.name}</td>
                  <td className="column-createdAt" data-label="Created At">
                    {person.createdAt
                      ? new Date(person.createdAt).toLocaleString("en-IN")
                      : "Not recorded"}
                  </td>
                  <td className="column-barcode" data-label="Barcode">{person.barcode}</td>
                  <td className="column-company" data-label="Company">{person.company ?? "-"}</td>
                  <td className="column-host" data-label="Host">{person.host ?? "-"}</td>
                  <td className="column-validTo" data-label="Valid until">{person.validTo && Number.isFinite(Date.parse(person.validTo)) ? <time dateTime={person.validTo}>{new Date(person.validTo).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}</time> : "Not set"}</td>
                  <td className="column-status" data-label="Status">
                    <span className={`registry-presence ${status === "pre_approved" ? "is-inside" : status === "expired" ? "is-outside" : ""}`}>{PERSON_STATUS_LABELS[status]}</span>
                  </td>
                  <td className="column-inside" data-label="Inside">
                    <span className={`registry-presence ${person.inside ? "is-inside" : "is-outside"}`}>
                      {person.inside ? "Inside" : "Outside"}
                    </span>
                  </td>
                  <td className="column-requests" data-label="Requests">
                    {person.status === "pending_approval" ? <Link className="admin-button admin-button--secondary secondary-button compact-button" href={`/admin/permissions?subject=${encodeURIComponent(person.id)}`} aria-label={`View approval request for ${person.name}`}>View approval</Link> : <Link className="admin-button admin-button--secondary secondary-button compact-button" href={`/admin/permissions?subject=${encodeURIComponent(person.id)}&requestType=zone_access`} aria-label={`Request zone access for ${person.name}`}>Request zone access</Link>}
                  </td>
                </tr>
              );
            })}
            {sortedRows.length === 0 && <tr><td colSpan={9}>No visitors found. Register a visitor to request access.</td></tr>}
          </tbody>
        </table>
      </div>
  );
}
