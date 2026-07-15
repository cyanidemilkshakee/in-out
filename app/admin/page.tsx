"use client";

import { useState, useMemo, lazy, Suspense } from "react";
import { MovementTable } from "../../components/admin/tables/MovementTable";
import type { Alert, MovementEvent, ScanAnalytics, SortDirection, VisibleColumn } from "../../lib/types";
import { useDataState } from "../../context/DataContext";

// Lazy-load the heavy Chart.js dashboard to avoid blocking initial render
const DashboardCharts = lazy(() =>
  import("../../components/analytics/DashboardCharts").then((m) => ({ default: m.DashboardCharts }))
);

const dashboardVisibleColumns: Record<VisibleColumn, boolean> = {
  date: true,
  time: true,
  name: true,
  type: true,
  direction: true,
  checkpoint: true,
  result: true,
  barcode: true,
  scanType: true,
  eventId: true
};

function DashboardOverview({
  alerts,
  scanAnalytics,
  events
}: {
  alerts: Alert[];
  scanAnalytics: ScanAnalytics;
  events: MovementEvent[];
}) {
  const latestEvents = useMemo(() => events.slice(0, 10), [events]);

  const [sortKey, setSortKey] = useState<VisibleColumn>("time");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [selectedEventId, setSelectedEventId] = useState<string>();

  return (
    <section className="dashboard-overview" aria-label="Operational overview" style={{ margin: 0, padding: 0 }}>
      {/* Full-viewport chart area */}
      <div style={{ position: "relative", width: "100%", height: "100vh" }}>
        <Suspense
          fallback={
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              color: "var(--admin-muted, #667085)",
              fontSize: "14px",
              fontWeight: 700,
              letterSpacing: "1px",
              textTransform: "uppercase",
            }}>
              Loading charts…
            </div>
          }
        >
          <DashboardCharts alerts={alerts} movements={events} scanAnalytics={scanAnalytics} />
        </Suspense>
      </div>

      {/* Recent movement logs below the viewport */}
      <div style={{ padding: '40px 24px 60px' }}>
        <h2 style={{ fontSize: '20px', fontWeight: 700, marginBottom: '24px', color: 'var(--admin-text, #111827)' }}>
          Recent Movement Logs
        </h2>
        <MovementTable
          events={latestEvents}
          selectedId={selectedEventId}
          visibleColumns={dashboardVisibleColumns}
          sortKey={sortKey}
          sortDirection={sortDirection}
          density="comfortable"
          onSort={(key) => {
            if (sortKey === key) {
              setSortDirection(sortDirection === "asc" ? "desc" : "asc");
            } else {
              setSortKey(key);
              setSortDirection("desc");
            }
          }}
          onSelect={(id) => setSelectedEventId(id === selectedEventId ? undefined : id)}
        />
      </div>
    </section>
  );
}

export default function AdminPage() {
  const { alerts, movements, scanAnalytics } = useDataState();

  return (
    <DashboardOverview
      alerts={alerts}
      scanAnalytics={scanAnalytics}
      events={movements}
    />
  );
}
