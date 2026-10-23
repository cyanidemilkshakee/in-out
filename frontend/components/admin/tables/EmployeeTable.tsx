import { Fragment, Suspense, lazy, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Eye } from 'lucide-react';
import { ActivityBar } from './ActivityBar';
import type { AccessPermission, Alert, MovementEvent, Person, RegistrySortKey, SortDirection } from '../../../../lib/types';
import type { PersonSessionIndex } from '../../../../lib/analyticsUtils';
import type { TimeRange } from '../../../../lib/dateRanges';
import { eventTimestamp } from '../../../../lib/dateRanges';
import { facilityZoneLabel, normalizeFacilityZones } from '../../../../lib/facilityZones';
import { PersonStatusLabel } from '../PersonStatusLabel';

// Lazy-load the chart-heavy profile card — keeps chart.js out of the initial bundle
const EmployeeProfileCard = lazy(() =>
  import('../EmployeeProfileCard').then((m) => ({ default: m.EmployeeProfileCard }))
);

type EmployeeSortKey = "name" | "createdAt" | "barcode" | "status" | "latestScan" | "inside" | "averageHours";

export function EmployeeTable({
  people: rows,
  movements,
  sessionsByPerson,
  timeRange,
  averageHoursByPerson,
  averageHoursLoading,
  permissions,
  alerts,
  sort,
}: {
  people: Person[];
  movements: MovementEvent[];
  sessionsByPerson: PersonSessionIndex;
  timeRange: TimeRange;
  averageHoursByPerson: Record<string, number | null> | null;
  averageHoursLoading: boolean;
  permissions: AccessPermission[];
  alerts: Alert[];
  sort?: { key: RegistrySortKey; direction: SortDirection; onChange: (key: RegistrySortKey) => void };
}) {
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null);
  const [localSortKey, setSortKey] = useState<EmployeeSortKey>("name");
  const [localSortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const sortKey = sort?.key ?? localSortKey;
  const sortDirection = sort?.direction ?? localSortDirection;
  const sortedRows = useMemo(() => {
    const latestByPerson = new Map<string, MovementEvent>();
    for (const movement of movements) {
      const current = latestByPerson.get(movement.subjectId);
      if (!current || eventTimestamp(movement) > eventTimestamp(current)) {
        latestByPerson.set(movement.subjectId, movement);
      }
    }
    return rows
      .map((person) => ({
        person,
        latestScan: latestByPerson.get(person.id),
        averageHours: averageHoursByPerson?.[person.id] ?? null,
      }))
      .sort((left, right) => {
        if (sort) return 0;
        const valueFor = ({ person, latestScan, averageHours }: typeof left) => {
          if (sortKey === "latestScan") return latestScan ? eventTimestamp(latestScan) : 0;
          if (sortKey === "inside") return Number(person.inside);
          if (sortKey === "averageHours") return averageHours ?? -1;
          return String(person[sortKey as keyof Person] ?? "");
        };
        const leftValue = valueFor(left);
        const rightValue = valueFor(right);
        const comparison = typeof leftValue === "number"
          ? leftValue - Number(rightValue)
          : leftValue.localeCompare(String(rightValue));
        return sortDirection === "asc" ? comparison : -comparison;
      });
  }, [averageHoursByPerson, movements, rows, sortDirection, sortKey, sort]);

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
            if (sort) { sort.onChange(column); return; }
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
      <div className="admin-table-wrap table-wrap scrollable-content">
        <table className="data-table employee-table registry-table registry-table--employees">
          <thead>
            <tr>
              {sortHeader("name", "Name")}
              {sortHeader("status", "Status")}
              {sortHeader("createdAt", "Created At")}
              {sortHeader("barcode", "Barcode")}
              <th className="column-zones">Zones</th>
              {sortHeader("latestScan", "Latest Scan", "latest-scan")}
              {sortHeader("inside", "Type", "type")}
              <th className="column-activity">Activity</th>
              {sortHeader("averageHours", `Avg h/day · ${timeRange}`, "average-hours")}
              <th className="column-profile">Profile</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map(({ person, latestScan, averageHours }) => {
              const assignedZones = normalizeFacilityZones(person.allowedZones);
              return (
                <tr key={person.id}>
                  <td className="column-name" data-label="Name">{person.name}</td>
                  <td className="column-status" data-label="Status">
                    <PersonStatusLabel status={person.status} />
                  </td>
                  <td className="column-createdAt" data-label="Created At">
                    {person.createdAt
                      ? new Date(person.createdAt).toLocaleString("en-IN")
                      : "Not recorded"}
                  </td>
                  <td className="column-barcode" data-label="Barcode">{person.barcode}</td>
                  <td className="column-zones" data-label="Zones">
                    <div className="facility-zone-list">
                      {assignedZones.length
                        ? assignedZones.map((zone) => <span className="facility-zone-tag" key={zone}>{facilityZoneLabel(zone)}</span>)
                        : "No zones assigned"}
                    </div>
                  </td>
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
                      <span className="employee-presence is-inside">Entry</span>
                    ) : (
                      <span className="employee-presence is-outside">Exit</span>
                    )}
                  </td>
                  <td className="column-activity" data-label="Activity">
                    <ActivityBar sessions={sessionsByPerson.get(person.id) ?? []} />
                  </td>
                  <td className="column-average-hours" data-label={`Avg hours/day (${timeRange})`}>
                    {averageHoursLoading ? "…" : averageHours === null ? "—" : `${averageHours.toFixed(1)} h`}
                  </td>
                  <td className="column-profile" data-label="Profile">
                    <button
                      className="admin-button admin-button--secondary secondary-button compact-button employee-profile-button"
                      type="button"
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
            permissions={permissions}
            alerts={alerts}
            movements={movements}
            onClose={() => setSelectedPerson(null)}
          />
        </Suspense>
      )}
      </Fragment>
  );
}
