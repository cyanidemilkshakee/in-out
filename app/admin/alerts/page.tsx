"use client";

import { useState } from "react";
import { initialAlerts } from "../../../lib/mockData";
import { AdminPageFrame, AlertsView } from "../../../components/admin/Tables";
import type { Alert } from "../../../lib/types";

export default function AlertsPage() {
  const [alerts, setAlerts] = useState(initialAlerts);

  function handleUpdateAlert(alertId: string, status: Alert["status"]) {
    setAlerts((current) =>
      current.map((alert) => (alert.id === alertId ? { ...alert, status } : alert))
    );
  }

  function handleBulkUpdateAlert(alertIds: string[], status: Alert["status"]) {
    setAlerts((current) =>
      current.map((alert) => (alertIds.includes(alert.id) ? { ...alert, status } : alert))
    );
  }

  return (
    <AdminPageFrame
      title="Alert Command"
      description="See every alert in the system while keeping active exceptions visible for immediate security response."
      metric={`${alerts.filter((alert) => alert.status === "open").length} active`}
    >
      <AlertsView 
        alerts={alerts} 
        onUpdate={handleUpdateAlert} 
        onBulkUpdate={handleBulkUpdateAlert} 
      />
    </AdminPageFrame>
  );
}
