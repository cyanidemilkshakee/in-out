"use client";

import { Bell, Scan, CheckCircle, XCircle, TrendingUp, TrendingDown } from "lucide-react";
import type { ScanAnalytics, Alert } from "../../lib/types";

type KPICardsProps = {
  alerts: Alert[];
  scanAnalytics: ScanAnalytics;
};

export function KPICards({ alerts, scanAnalytics }: KPICardsProps) {
  return (
    <div className="dashboard-kpi-grid animate-slide-up delay-100" style={{
      position: "absolute",
      top: "100px",
      left: 0,
      width: "100%",
      display: "flex",
      justifyContent: "center",
      gap: "16px",
      zIndex: 20
    }}>
      {/* Total Scans */}
      <div className="metric-widget-box dashboard-kpi-card" style={{ width: "200px", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--admin-muted)" }}>
          <Scan size={18} />
          <span style={{ fontSize: "14px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px" }}>Total Scans</span>
        </div>
        <div style={{ fontSize: "32px", fontWeight: 800, color: "var(--admin-text)", lineHeight: 1 }}>
          {scanAnalytics.totalScans.toLocaleString()}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", fontWeight: 600, color: "#12b76a", marginTop: "-6px" }}>
          <TrendingUp size={14} /> <span>12%</span> <span style={{ color: "var(--admin-muted)", fontWeight: 500 }}>vs Yesterday</span>
        </div>
      </div>

      {/* Alerts */}
      <div className="metric-widget-box dashboard-kpi-card" style={{ width: "200px", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--admin-muted)" }}>
          <Bell size={18} />
          <span style={{ fontSize: "14px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px" }}>Alerts</span>
        </div>
        <div style={{ fontSize: "32px", fontWeight: 800, color: "var(--admin-text)", lineHeight: 1 }}>
          {alerts.length.toLocaleString()}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", fontWeight: 600, color: "#d92d20", marginTop: "-6px" }}>
          <TrendingUp size={14} /> <span>4%</span> <span style={{ color: "var(--admin-muted)", fontWeight: 500 }}>vs Yesterday</span>
        </div>
      </div>

      {/* Approved */}
      <div className="metric-widget-box dashboard-kpi-card" style={{ width: "200px", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--admin-muted)" }}>
          <CheckCircle size={18} />
          <span style={{ fontSize: "14px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px" }}>Approved</span>
        </div>
        <div style={{ fontSize: "32px", fontWeight: 800, color: "var(--admin-text)", lineHeight: 1 }}>
          {scanAnalytics.totalApproved.toLocaleString()}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", fontWeight: 600, color: "#12b76a", marginTop: "-6px" }}>
          <TrendingUp size={14} /> <span>8%</span> <span style={{ color: "var(--admin-muted)", fontWeight: 500 }}>vs Yesterday</span>
        </div>
      </div>

      {/* Denied */}
      <div className="metric-widget-box dashboard-kpi-card" style={{ width: "200px", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--admin-muted)" }}>
          <XCircle size={18} />
          <span style={{ fontSize: "14px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px" }}>Denied</span>
        </div>
        <div style={{ fontSize: "32px", fontWeight: 800, color: "var(--admin-text)", lineHeight: 1 }}>
          {scanAnalytics.totalDenied.toLocaleString()}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", fontWeight: 600, color: "#d92d20", marginTop: "-6px" }}>
          <TrendingDown size={14} /> <span>3%</span> <span style={{ color: "var(--admin-muted)", fontWeight: 500 }}>vs Yesterday</span>
        </div>
      </div>
    </div>
  );
}
