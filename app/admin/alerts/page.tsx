"use client";

import { useState } from "react";
import { initialAlerts } from "../../../lib/mockData";
import { AlertsView } from "../../../components/admin/Tables";

export default function AlertsPage() {
  const [alerts, setAlerts] = useState(initialAlerts);

  function handleUpdateAlert(alertId: string, status: any) {
    setAlerts((current) =>
      current.map((alert) => (alert.id === alertId ? { ...alert, status } : alert))
    );
  }

  function handleBulkUpdateAlert(alertIds: string[], status: any) {
    setAlerts((current) =>
      current.map((alert) => (alertIds.includes(alert.id) ? { ...alert, status } : alert))
    );
  }

  return (
    <div style={{ padding: "24px", maxWidth: "1200px", margin: "0 auto" }}>
      <AlertsView 
        alerts={alerts} 
        onUpdate={handleUpdateAlert} 
        onBulkUpdate={handleBulkUpdateAlert} 
      />
    </div>
  );
}
