import { Fragment, Suspense, lazy, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Eye } from 'lucide-react';
import { ActivityBar } from './ActivityBar';
import type { MovementEvent, Person } from '../../../../lib/types';
import type { PersonSessionIndex } from '../../../../lib/analyticsUtils';
import { eventTimestamp } from '../../../../lib/dateRanges';

// Lazy-load the chart-heavy profile card — keeps chart.js out of the initial bundle
const EmployeeProfileCard = lazy(() =>
  import('../EmployeeProfileCard').then((m) => ({ default: m.EmployeeProfileCard }))
);

type EmployeeSortKey = "name" | "createdAt" | "barcode" | "accessLevel" | "department" | "latestScan" | "inside";

export function EmployeeTable({
  people: rows,
  movements,
  sessionsByPerson,
}: {
  people: Person[];
  movements: MovementEvent[];
  sessionsByPerson: PersonSessionIndex;
}) {
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null);
  const [sortKey, setSortKey] = useState<EmployeeSortKey>("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const sortedRows = useMemo(() => {
    const latestByPerson = new Map<string, MovementEvent>();
    for (const movement of movements) {
      const current = latestByPerson.get(movement.subjectId);
      if (!current || eventTimestamp(movement) > eventTimestamp(current)) {
        latestByPerson.set(movement.subjectId, movement);
      }
    }
    return rows
      .map((person) => ({ person, latestScan: latestByPerson.get(person.id) }))
      .sort((left, right) => {
        const valueFor = ({ person, latestScan }: typeof left) => {
          if (sortKey === "latestScan") return latestScan ? eventTimestamp(latestScan) : 0;
          if (sortKey === "inside") return Number(person.inside);
          return String(person[sortKey] ?? "");
        };
        const leftValue = valueFor(left);
        const rightValue = valueFor(right);
        const comparison = typeof leftValue === "number"
          ? leftValue - Number(rightValue)
          : leftValue.localeCompare(String(rightValue));
        return sortDirection === "asc" ? comparison : -comparison;
      });
  }, [movements, rows, sortDirection, sortKey]);

  function sortHeader(column: EmployeeSortKey, label: string, className: string = column) {
    const active = sortKey === column;
    return (
      <th
        className={`column-${className}`}
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
          {active
            ? sortDirection === "asc"
              ? <ArrowUp size={16} />
              : <ArrowDown size={16} />
            : <ArrowUpDown size={16} />}
        </button>
      </th>
    );
  }

  return (
      <Fragment>
      <div className="table-wrap table-wrap-condensed">
        <table className="data-table data-table-condensed employee-table">
          <thead>
            <tr>
              {sortHeader("name", "Name")}
              {sortHeader("createdAt", "Created At")}
              {sortHeader("barcode", "Barcode")}
              {sortHeader("accessLevel", "Access", "access")}
              {sortHeader("department", "Department")}
              {sortHeader("latestScan", "Latest Scan", "latest-scan")}
              {sortHeader("inside", "Type", "type")}
              <th className="column-activity">Activity</th>
              <th className="column-profile">Profile</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map(({ person, latestScan }) => {
              return (
                <tr key={person.id}>
                  <td className="column-name" data-label="Name">{person.name}</td>
                  <td className="column-createdAt" data-label="Created At">
                    {person.createdAt
                      ? new Date(person.createdAt).toLocaleString("en-IN")
                      : "Not recorded"}
                  </td>
                  <td className="column-barcode" data-label="Barcode">{person.barcode}</td>
                  <td className="column-access" data-label="Access">{person.accessLevel}</td>
                  <td className="column-department" data-label="Department">{person.department ?? "-"}</td>
                  <td className="column-latest-scan mono" data-label="Latest scan">
                    {latestScan
                      ? new Date(eventTimestamp(latestScan)).toLocaleString("en-IN", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })
                      : "No scans"}
                  </td>
                  <td className="column-type" data-label="Type">
                    {person.inside ? (
                      <span style={{ color: "var(--green)", fontWeight: 600 }}>Entry</span>
                    ) : (
                      <span style={{ color: "var(--red)", fontWeight: 600 }}>Exit</span>
                    )}
                  </td>
                  <td className="column-activity" data-label="Activity">
                    <ActivityBar sessions={sessionsByPerson.get(person.id) ?? []} />
                  </td>
                  <td className="column-profile" data-label="Profile">
                    <button 
                      className="secondary-button compact-button" 
                      type="button" 
                      style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                      onClick={() => setSelectedPerson(person)}
                    >
                      <Eye size={14} />
                      View
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {selectedPerson && (
        <Suspense fallback={null}>
          <EmployeeProfileCard
            person={selectedPerson}
            sessions={sessionsByPerson.get(selectedPerson.id) ?? []}
            onClose={() => setSelectedPerson(null)}
          />
        </Suspense>
      )}
      </Fragment>
  );
}
