"use client";

import { useState, useMemo } from "react";
import dynamic from "next/dynamic";
import { MovementTable } from "../../components/admin/Tables";
import {
  initialAlerts,
  initialMovements,
  scanAnalytics,
} from "../../lib/mockData";
import type { Alert, MovementEvent, ScanAnalytics, SortDirection, VisibleColumn } from "../../lib/types";

const DashboardCharts = dynamic(
  () => import("../../components/analytics/DashboardCharts").then((m) => ({ default: m.DashboardCharts })),
  {
    ssr: false,
    loading: () => (
      <div style={{
        position: "absolute", inset: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "var(--bg)",
      }}>
        <div style={{
          width: 40, height: 40,
          border: "3px solid var(--border)",
          borderTopColor: "var(--blue)",
          borderRadius: "50%",
          animation: "spin 0.7s linear infinite",
        }} />
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    ),
  }
);

function DashboardOverview({
  alerts,
  metrics,
  scanAnalytics,
  events
}: {
  alerts: Alert[];
  metrics: { active: number; today: number };
  scanAnalytics: ScanAnalytics;
  events: MovementEvent[];
}) {
  const latestEvents = events.slice(0, 10);

  const [sortKey, setSortKey] = useState<VisibleColumn>("time");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [selectedEventId, setSelectedEventId] = useState<string>();
  const visibleColumns: Record<VisibleColumn, boolean> = {
    time: true,
    checkpoint: true,
    direction: true,
    subject: true,
    type: true,
    barcode: true,
    result: true,
    reason: true,
    scanner: false,
    sync: true
  };

  return (
    <section className="dashboard-overview" aria-label="Operational overview" style={{ margin: 0, padding: 0 }}>
      <div style={{ position: "relative", width: "100%", height: "100vh" }}>
        <DashboardCharts
          alerts={alerts}
          scanAnalytics={scanAnalytics}
        />
      </div>
      
      <div style={{ padding: '40px 24px 60px' }}>
        <h2 style={{ fontSize: '20px', fontWeight: 700, marginBottom: '24px', color: '#111827' }}>Recent Movement Logs</h2>
        <MovementTable
          events={latestEvents}
          selectedId={selectedEventId}
          visibleColumns={visibleColumns}
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
  const metrics = useMemo(() => ({ active: 124, today: 450 }), []);

  return (
    <DashboardOverview
      alerts={initialAlerts}
      metrics={metrics}
      scanAnalytics={scanAnalytics}
      events={initialMovements}
    />
  );
}
