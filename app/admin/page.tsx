"use client";

import { useMemo } from "react";
import { DashboardCharts } from "../../components/analytics/DashboardCharts";
import {
  initialAlerts,
  initialMovements,
  scanAnalytics,
  scanners
} from "../../lib/mockData";
import type { Alert, MovementEvent, ScanAnalytics, Scanner } from "../../lib/types";

function formatClock(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function DashboardOverview({
  alerts,
  metrics,
  scanAnalytics,
  scannerState,
  events
}: {
  alerts: Alert[];
  metrics: { active: number; today: number };
  scanAnalytics: ScanAnalytics;
  scannerState: Scanner[];
  events: MovementEvent[];
}) {
  const latestEvents = events.slice(0, 10);
  const activeAlerts = alerts.filter((alert) => alert.status === "open");

  return (
    <section className="dashboard-overview" aria-label="Operational overview" style={{ margin: 0, padding: 0 }}>
      <DashboardCharts
        alerts={activeAlerts}
        scanAnalytics={scanAnalytics}
        events={latestEvents}
        scanners={scannerState}
      />
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
      scannerState={scanners}
      events={initialMovements}
    />
  );
}
