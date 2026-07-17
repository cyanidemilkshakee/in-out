"use client";

import { lazy, Suspense, useMemo, useState } from "react";
import { MovementTable } from "../../../components/admin/tables/MovementTable";
import { useDataState } from "../../../context/DataContext";
import type {
  Alert,
  MovementEvent,
  ScanAnalytics,
  SortDirection,
  VisibleColumn,
} from "../../../lib/types";

const DashboardCharts = lazy(() =>
  import("../../../components/analytics/DashboardCharts").then((module) => ({
    default: module.DashboardCharts,
  }))
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
  eventId: true,
};

function DashboardOverview({
  alerts,
  scanAnalytics,
  events,
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
    <section className="dashboard-overview" aria-label="Operational overview">
      <div className="dashboard-chart-viewport">
        <Suspense
          fallback={
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "var(--admin-muted, #667085)",
                fontSize: "14px",
                fontWeight: 700,
                letterSpacing: "1px",
                textTransform: "uppercase",
              }}
            >
              Loading charts…
            </div>
          }
        >
          <DashboardCharts
            alerts={alerts}
            movements={events}
            scanAnalytics={scanAnalytics}
          />
        </Suspense>
      </div>

      <div className="dashboard-log-section">
        <h2>Recent Movement Logs</h2>
        <MovementTable
          events={latestEvents}
          selectedId={selectedEventId}
          visibleColumns={dashboardVisibleColumns}
          sortKey={sortKey}
          sortDirection={sortDirection}
          density="comfortable"
          onSort={(key) => {
            if (sortKey === key) {
              setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
            } else {
              setSortKey(key);
              setSortDirection("desc");
            }
          }}
          onSelect={(id) =>
            setSelectedEventId((current) => (id === current ? undefined : id))
          }
        />
      </div>
    </section>
  );
}

export default function AdminDashboardPage() {
  const { alerts, movements, scanAnalytics } = useDataState();

  return (
    <DashboardOverview
      alerts={alerts}
      scanAnalytics={scanAnalytics}
      events={movements}
    />
  );
}
