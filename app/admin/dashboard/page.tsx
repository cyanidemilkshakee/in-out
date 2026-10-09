"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { MovementTable } from "../../../frontend/components/admin/tables/MovementTable";
import { useDataState } from "../../../frontend/context/DataContext";
import type {
  Alert,
  MovementEvent,
  Person,
  PermissionRequest,
  SortDirection,
  VisibleColumn,
} from "../../../lib/types";

const DashboardCharts = dynamic(
  () =>
    import("../../../frontend/components/analytics/DashboardCharts").then(
      (module) => module.DashboardCharts
    ),
  {
    ssr: false,
    loading: () => (
      <div className="dashboard-chart-loading">Loading charts…</div>
    ),
  }
);

const dashboardVisibleColumns: Record<VisibleColumn, boolean> = {
  date: true,
  time: true,
  createdAt: false,
  name: true,
  active: false,
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
  events,
  people,
  pendingRequests,
}: {
  alerts: Alert[];
  events: MovementEvent[];
  people: Person[];
  pendingRequests: PermissionRequest[];
}) {
  const latestEvents = useMemo(() => events.slice(0, 10), [events]);
  const [sortKey, setSortKey] = useState<VisibleColumn>("time");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  return (
    <section className="dashboard-overview" aria-label="Operational overview">
      <div className="dashboard-chart-viewport">
        <DashboardCharts
          alerts={alerts}
          movements={events}
          pendingRequests={pendingRequests}
        />
      </div>

      <div className="dashboard-log-section">
        <h2 id="recent-log-heading">Recent Logs</h2>
        <MovementTable
          events={latestEvents}
          people={people}
          visibleColumns={dashboardVisibleColumns}
          sortKey={sortKey}
          sortDirection={sortDirection}
          density="comfortable"
          onSort={(key) => {
            if (sortKey === key) {
              setSortDirection((current) =>
                current === "asc" ? "desc" : "asc"
              );
            } else {
              setSortKey(key);
              setSortDirection("desc");
            }
          }}
        />
      </div>
    </section>
  );
}

export default function AdminDashboardPage() {
  const { alerts, movements, people, permissionRequests } = useDataState();

  return (
    <DashboardOverview
      alerts={alerts}
      events={movements}
      people={people}
      pendingRequests={permissionRequests.filter((request) => request.status === "pending")}
    />
  );
}
