import { Fragment, Suspense, lazy, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Eye } from 'lucide-react';
import { ActivityBar } from './ActivityBar';
import type { Person } from '../../../lib/types';

// Lazy-load the chart-heavy profile card — keeps chart.js out of the initial bundle
const EmployeeProfileCard = lazy(() =>
  import('../EmployeeProfileCard').then((m) => ({ default: m.EmployeeProfileCard }))
);

type EmployeeSortKey = "name" | "createdAt" | "barcode" | "accessLevel" | "department" | "latestScan" | "inside";

function getMockScan(person: Person) {
  const seedValue = person.id.split("").reduce((total, character) => total + character.charCodeAt(0), 0);
  const hour = 7 + (seedValue % 5);
  const minute = seedValue % 60;
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour > 12 ? hour - 12 : hour;

  return {
    label: `${displayHour}:${String(minute).padStart(2, "0")} ${period}`,
    value: hour * 60 + minute,
  };
}

export function EmployeeTable({
  people: rows,
}: {
  people: Person[];
}) {
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null);
  const [sortKey, setSortKey] = useState<EmployeeSortKey>("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const sortedRows = useMemo(() => {
    return rows
      .map((person) => ({ person, mockScan: getMockScan(person) }))
      .sort((left, right) => {
        const valueFor = ({ person, mockScan }: typeof left) => {
          if (sortKey === "latestScan") return mockScan.value;
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
  }, [rows, sortDirection, sortKey]);

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
            {sortedRows.map(({ person, mockScan }) => {
              return (
                <tr key={person.id}>
                  <td className="column-name" data-label="Name">{person.name}</td>
                  <td className="column-createdAt" data-label="Created At">{person.createdAt || "Jul 15, 2026, 10:00 AM"}</td>
                  <td className="column-barcode" data-label="Barcode">{person.barcode}</td>
                  <td className="column-access" data-label="Access">{person.accessLevel}</td>
                  <td className="column-department" data-label="Department">{person.department ?? "-"}</td>
                  <td className="column-latest-scan mono" data-label="Latest scan">{mockScan.label}</td>
                  <td className="column-type" data-label="Type">
                    {person.inside ? (
                      <span style={{ color: "var(--green)", fontWeight: 600 }}>Entry</span>
                    ) : (
                      <span style={{ color: "var(--red)", fontWeight: 600 }}>Exit</span>
                    )}
                  </td>
                  <td className="column-activity" data-label="Activity">
                    <ActivityBar seed={person.id} />
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
            onClose={() => setSelectedPerson(null)}
          />
        </Suspense>
      )}
      </Fragment>
  );
}
