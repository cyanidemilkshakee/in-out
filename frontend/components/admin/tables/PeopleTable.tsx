import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { Person } from '../../../../lib/types';

export function PeopleTable({
  title,
  people: rows,
}: {
  title: string;
  people: Person[];
}) {
  const [sortKey, setSortKey] = useState<keyof Person>("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      const aValue = String(a[sortKey] ?? "");
      const bValue = String(b[sortKey] ?? "");
      return sortDirection === "asc" ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
    });
  }, [rows, sortDirection, sortKey]);

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
      <div className="admin-table-wrap table-wrap registry-table-wrap">
        <table className="data-table people-table registry-table registry-table--people">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              {sortHeader("name", "Name")}
              {sortHeader("createdAt", "Created At")}
              {sortHeader("barcode", "Barcode")}
              {sortHeader("company", "Department / Company")}
              {sortHeader("status", "Status")}
              {sortHeader("inside", "Inside")}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((person) => (
              <tr key={person.id}>
                <td className="column-name" data-label="Name">{person.name}</td>
                <td className="column-createdAt" data-label="Created At">
                  {person.createdAt
                    ? new Date(person.createdAt).toLocaleString("en-IN")
                    : "Not recorded"}
                </td>
                <td className="column-barcode" data-label="Barcode">{person.barcode}</td>
                <td className="column-company" data-label="Department / Company">{person.department ?? person.company ?? "-"}</td>
                <td className="column-status" data-label="Status">{person.status}</td>
                <td className="column-inside" data-label="Inside">
                  <span className={`registry-presence ${person.inside ? "is-inside" : "is-outside"}`}>
                    {person.inside ? "Inside" : "Outside"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
  );
}
