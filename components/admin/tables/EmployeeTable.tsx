import { Fragment, Suspense, lazy, useState } from 'react';
import { Eye } from 'lucide-react';
import { ActivityBar } from './ActivityBar';
import type { Person } from '../../../lib/types';

// Lazy-load the chart-heavy profile card — keeps chart.js out of the initial bundle
const EmployeeProfileCard = lazy(() =>
  import('../EmployeeProfileCard').then((m) => ({ default: m.EmployeeProfileCard }))
);

export function EmployeeTable({
  people: rows,
}: {
  people: Person[];
}) {
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null);

  return (
      <Fragment>
      <div className="table-wrap table-wrap-condensed">
        <table className="data-table data-table-condensed">
          <thead>
            <tr>
              <th>Name</th>
              <th>Barcode</th>
              <th>Access</th>
              <th>Department</th>
              <th>Latest Scan</th>
              <th>Type</th>
              <th>Activity</th>
              <th>Profile</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((person) => {
              // Generate a deterministic mock time based on their ID string length and characters
              const seedVal = person.id.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
              const hour = 7 + (seedVal % 5); // 7 AM to 11 AM
              const minute = String(seedVal % 60).padStart(2, "0");
              const ampm = hour >= 12 ? "PM" : "AM";
              const displayHour = hour > 12 ? hour - 12 : hour;
              const mockTime = `${displayHour}:${minute} ${ampm}`;

              return (
                <tr key={person.id}>
                  <td data-label="Name">{person.name}</td>
                  <td data-label="Barcode">{person.barcode}</td>
                  <td data-label="Access">{person.accessLevel}</td>
                  <td data-label="Department">{person.department ?? "-"}</td>
                  <td data-label="Latest scan" className="mono">{mockTime}</td>
                  <td data-label="Type">
                    {person.inside ? (
                      <span style={{ color: "var(--green)", fontWeight: 600 }}>Entry</span>
                    ) : (
                      <span style={{ color: "var(--red)", fontWeight: 600 }}>Exit</span>
                    )}
                  </td>
                  <td data-label="Activity">
                    <ActivityBar seed={person.id} />
                  </td>
                  <td data-label="Profile">
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
