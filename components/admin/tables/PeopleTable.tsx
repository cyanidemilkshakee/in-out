import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { Person } from '../../../lib/types';

export function PeopleTable({
  title,
  people: rows,
  onToggleInside,
  action
}: {
  title: string;
  people: Person[];
  onToggleInside: (personId: string) => void;
  action?: ReactNode;
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
      <th aria-sort={active ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}>
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
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              {sortHeader("name", "Name")}
              {sortHeader("barcode", "Barcode")}
              {sortHeader("accessLevel", "Access")}
              {sortHeader("company", "Department / Company")}
              {sortHeader("status", "Status")}
              {sortHeader("inside", "Inside")}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((person) => (
              <tr key={person.id}>
                <td>{person.name}</td>
                <td>{person.barcode}</td>
                <td>{person.accessLevel}</td>
                <td>{person.department ?? person.company ?? "-"}</td>
                <td>{person.status}</td>
                <td>{person.inside ? "Inside" : "Outside"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
  );
}
