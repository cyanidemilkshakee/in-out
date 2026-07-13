"use client";

import { useMemo, useState } from "react";
import { Doughnut } from "react-chartjs-2";
import { Bell, Scan, CheckCircle, XCircle, TrendingUp, TrendingDown, ChevronRight } from "lucide-react";
import { DrillDownDoughnut, mockData } from "./DrillDownDoughnut";
import type { Alert, ScanAnalytics } from "../../lib/types";

// ChartJS.register is handled by DrillDownDoughnut (same elements, module-level)

type DashboardChartsProps = {
  alerts: Alert[];
  scanAnalytics: ScanAnalytics;
};

const chartFont = {
  family: "var(--font-urbanist, Urbanist), Arial, sans-serif"
};

const mutedText = "#52605d";

const sharedPlugins = {
  legend: {
    labels: {
      boxHeight: 9,
      boxWidth: 9,
      color: mutedText,
      font: { ...chartFont, size: 12, weight: 700 }
    }
  },
  tooltip: {
    backgroundColor: "#18201f",
    bodyFont: { ...chartFont, size: 12 },
    cornerRadius: 8,
    displayColors: false,
    titleFont: { ...chartFont, size: 12, weight: 800 }
  }
} as const;



export function DashboardCharts({
  alerts,
  scanAnalytics
}: DashboardChartsProps) {
  const [timeRange, setTimeRange] = useState("Today");
  const timeRanges = ["Today", "This Week", "This Month", "This Year", "All Time"];

  const openAlerts = useMemo(
    () => alerts.filter((alert) => alert.status !== "resolved"),
    [alerts]
  );

  const chartData = useMemo(() => ({
    scanMix: {
      labels: ["Entries", "Exits"],
      datasets: [{
        data: [scanAnalytics.totalEntries, scanAnalytics.totalExits],
        backgroundColor: ["#12b76a", "#027a48"],
        borderColor: "#f7faf9",
        borderWidth: 4
      }]
    },
    autoVsManual: {
      labels: ["Automatic", "Manual"],
      datasets: [{
        data: [scanAnalytics.totalAutomatic ?? 350, scanAnalytics.totalManual ?? 100],
        backgroundColor: ["#0b63e5", "#667085"],
        borderColor: "#f7faf9",
        borderWidth: 4
      }]
    },
    deniedMix: {
      labels: ["Restricted", "Expired"],
      datasets: [{
        data: [scanAnalytics.totalRestricted ?? 180, scanAnalytics.totalExpired ?? 70],
        backgroundColor: ["#f04438", "#912018"],
        borderColor: "#f7faf9",
        borderWidth: 4
      }]
    },
    quality: {
      labels: ["Approved", "Denied"],
      datasets: [{
        data: [scanAnalytics.totalApproved, scanAnalytics.totalDenied],
        backgroundColor: ["#12b76a", "#f04438"],
        borderColor: "#f7faf9",
        borderWidth: 4
      }]
    },
  }), [scanAnalytics]);

  return (
    <section className="dashboard-analytics" aria-label="Dashboard analytics" style={{
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      display: "grid",
      gridTemplateColumns: "1fr 0.8fr 1fr",
      gridTemplateRows: "1fr 1fr",
      padding: "50px 24px 24px 18px",
      boxSizing: "border-box",
      zIndex: 0
    }}>
      {/* KPI Cards Row */}
      <div className="animate-slide-up delay-100" style={{
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
        <div className="metric-widget-box" style={{ width: "200px", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#667085" }}>
            <Scan size={18} />
            <span style={{ fontSize: "14px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px" }}>Total Scans</span>
          </div>
          <div style={{ fontSize: "32px", fontWeight: 800, color: "#111827", lineHeight: 1 }}>
            {(scanAnalytics.totalEntries + scanAnalytics.totalExits).toLocaleString()}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", fontWeight: 600, color: "#12b76a", marginTop: "-6px" }}>
            <TrendingUp size={14} /> <span>12%</span> <span style={{ color: "#667085", fontWeight: 500 }}>vs Yesterday</span>
          </div>
        </div>

        {/* Alerts */}
        <div className="metric-widget-box" style={{ width: "200px", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#667085" }}>
            <Bell size={18} />
            <span style={{ fontSize: "14px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px" }}>Alerts</span>
          </div>
          <div style={{ fontSize: "32px", fontWeight: 800, color: "#111827", lineHeight: 1 }}>
            {alerts.length.toLocaleString()}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", fontWeight: 600, color: "#d92d20", marginTop: "-6px" }}>
            <TrendingUp size={14} /> <span>4%</span> <span style={{ color: "#667085", fontWeight: 500 }}>vs Yesterday</span>
          </div>
        </div>

        {/* Approved */}
        <div className="metric-widget-box" style={{ width: "200px", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#667085" }}>
            <CheckCircle size={18} />
            <span style={{ fontSize: "14px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px" }}>Approved</span>
          </div>
          <div style={{ fontSize: "32px", fontWeight: 800, color: "#111827", lineHeight: 1 }}>
            {scanAnalytics.totalApproved.toLocaleString()}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", fontWeight: 600, color: "#12b76a", marginTop: "-6px" }}>
            <TrendingUp size={14} /> <span>8%</span> <span style={{ color: "#667085", fontWeight: 500 }}>vs Yesterday</span>
          </div>
        </div>

        {/* Denied */}
        <div className="metric-widget-box" style={{ width: "200px", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#667085" }}>
            <XCircle size={18} />
            <span style={{ fontSize: "14px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px" }}>Denied</span>
          </div>
          <div style={{ fontSize: "32px", fontWeight: 800, color: "#111827", lineHeight: 1 }}>
            {scanAnalytics.totalDenied.toLocaleString()}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", fontWeight: 600, color: "#d92d20", marginTop: "-6px" }}>
            <TrendingDown size={14} /> <span>3%</span> <span style={{ color: "#667085", fontWeight: 500 }}>vs Yesterday</span>
          </div>
        </div>
      </div>

      {/* Time Range Selector */}
      <div style={{
        position: "absolute",
        top: "32px",
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        background: "rgba(24, 32, 31, 0.04)",
        padding: "6px",
        borderRadius: "20px",
        gap: "6px",
        zIndex: 10
      }}>
        {timeRanges.map(range => (
          <button
            key={range}
            onClick={() => setTimeRange(range)}
            style={{
              background: timeRange === range ? "#fff" : "transparent",
              color: timeRange === range ? "#000" : "#52605d",
              border: "none",
              padding: "8px 16px",
              borderRadius: "16px",
              fontSize: "16px",
              fontWeight: timeRange === range ? 700 : 600,
              cursor: "pointer",
              boxShadow: timeRange === range ? "0 2px 6px rgba(0,0,0,0.1)" : "none",
              transition: "all 0.2s ease"
            }}
          >
            {range}
          </button>
        ))}
      </div>

      {/* Top Left */}
      <div className="analytics-donut animate-slide-up delay-100" style={{ gridColumn: 1, gridRow: 1, alignSelf: "start", justifySelf: "start", width: "100%", maxWidth: "260px", aspectRatio: "1/1", marginLeft: "-22px" }}>
        <div style={{ position: "absolute", top: "calc(100% + 14px)", left: "50%", transform: "translateX(-50%)", whiteSpace: "nowrap", fontSize: "16px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", color: "#000" }}>Scan Status</div>
        <Doughnut
          data={chartData.quality}
          options={{
            cutout: "75%",
            maintainAspectRatio: false,
            plugins: { ...sharedPlugins, legend: { display: false } }
          }}
        />
        <div style={{ position: "absolute", top: "0", left: "0", width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", pointerEvents: "none", paddingTop: "8px" }}>
          <div style={{ textAlign: "center", marginBottom: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#12b76a", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#12b76a" }} />
              Approved
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{scanAnalytics.totalApproved.toLocaleString()}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#f04438", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#f04438" }} />
              Denied
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{scanAnalytics.totalDenied.toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Top Right (Now Scan Method) */}
      <div className="analytics-donut animate-slide-up delay-150" style={{ gridColumn: 1, gridRow: 2, alignSelf: "end", justifySelf: "start", width: "100%", maxWidth: "260px", aspectRatio: "1/1", marginLeft: "-22px", marginBottom: "16px" }}>
        <div style={{ position: "absolute", bottom: "calc(100% + 14px)", left: "50%", transform: "translateX(-50%)", whiteSpace: "nowrap", fontSize: "16px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", color: "#000" }}>Approved Scans</div>
        <Doughnut
          data={chartData.scanMix}
          options={{
            cutout: "75%",
            maintainAspectRatio: false,
            plugins: { ...sharedPlugins, legend: { display: false } }
          }}
        />
        <div style={{ position: "absolute", top: "0", left: "0", width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", pointerEvents: "none", paddingTop: "8px" }}>
          <div style={{ textAlign: "center", marginBottom: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#12b76a", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#12b76a" }} />
              Entries
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{scanAnalytics.totalEntries.toLocaleString()}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#027a48", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#027a48" }} />
              Exits
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{scanAnalytics.totalExits.toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Bottom Left (Now Traffic Flow) */}
      <div className="analytics-donut animate-slide-up delay-200" style={{ gridColumn: 3, gridRow: 1, alignSelf: "start", justifySelf: "end", width: "100%", maxWidth: "260px", aspectRatio: "1/1" }}>
        <div style={{ position: "absolute", top: "calc(100% + 14px)", left: "50%", transform: "translateX(-50%)", whiteSpace: "nowrap", fontSize: "16px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", color: "#000" }}>Scan Methods</div>
        <Doughnut
          data={chartData.autoVsManual}
          options={{
            cutout: "75%",
            maintainAspectRatio: false,
            plugins: { ...sharedPlugins, legend: { display: false } }
          }}
        />
        <div style={{ position: "absolute", top: "0", left: "0", width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", pointerEvents: "none", paddingTop: "8px" }}>
          <div style={{ textAlign: "center", marginBottom: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#0b63e5", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#0b63e5" }} />
              Automatic
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{(scanAnalytics.totalAutomatic ?? 350).toLocaleString()}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#667085", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#667085" }} />
              Manual
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{(scanAnalytics.totalManual ?? 100).toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Bottom Right */}
      <div className="analytics-donut animate-slide-up delay-250" style={{ gridColumn: 3, gridRow: 2, alignSelf: "end", justifySelf: "end", width: "100%", maxWidth: "260px", aspectRatio: "1/1", marginBottom: "16px" }}>
        <div style={{ position: "absolute", bottom: "calc(100% + 14px)", left: "50%", transform: "translateX(-50%)", whiteSpace: "nowrap", fontSize: "16px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", color: "#000" }}>Denied Scans</div>
        <Doughnut
          data={chartData.deniedMix}
          options={{
            cutout: "75%",
            maintainAspectRatio: false,
            plugins: { ...sharedPlugins, legend: { display: false } }
          }}
        />
        <div style={{ position: "absolute", top: "0", left: "0", width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", pointerEvents: "none", paddingTop: "8px" }}>
          <div style={{ textAlign: "center", marginBottom: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#f04438", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#f04438" }} />
              Restricted
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{(scanAnalytics.totalRestricted ?? 180).toLocaleString()}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", color: "#912018", fontSize: "14px", fontWeight: 750, textTransform: "uppercase" }}>
              <span style={{ display: "block", width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#912018" }} />
              Expired
            </div>
            <div style={{ fontSize: "16px", fontWeight: 800, lineHeight: 1 }}>{(scanAnalytics.totalExpired ?? 70).toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Center Right - Active Alerts Box */}
      <div className="animate-slide-up delay-300 alert-widget-box" style={{
        gridColumn: 3,
        gridRow: "1 / -1",
        alignSelf: "center",
        justifySelf: "end",
        width: "100%",
        maxWidth: "400px",
        height: "auto",
        display: "flex",
        flexDirection: "column",
        gap: "0",
        background: "transparent",
        borderRadius: "16px",
        padding: "24px 16px 8px 16px",
        overflow: "hidden",
        marginTop: "-15px"
      }}>
        <div className="alert-widget-header" style={{ display: "flex", alignItems: "center", paddingBottom: "16px", background: "transparent", justifyContent: "center", gap: "4px" }}>
          <span style={{ fontSize: "18px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px", color: "#18201f" }}>Active Alerts</span>
          <ChevronRight size={18} color="#18201f" className="alert-widget-chevron" />
        </div>
        
        <style>{`
          .alert-widget-box {
            border: 1px solid transparent;
            transition: border-color 0.2s ease;
          }
          .alert-widget-box:hover {
            border: 1px solid #475467;
          }
          .alert-widget-header {
            border-bottom: none;
            transition: border-color 0.2s ease;
          }
          .alert-widget-chevron {
            opacity: 0;
            transition: opacity 0.2s ease, transform 0.2s ease;
            transform: translateX(-4px);
          }
          .alert-widget-box:hover .alert-widget-chevron {
            opacity: 1;
            transform: translateX(0);
          }
          .alert-list-container {
            overflow-y: hidden;
          }
          .alert-list-container:hover {
            overflow-y: auto;
          }
          .alert-list-container::-webkit-scrollbar {
            width: 4px;
          }
          .alert-list-container::-webkit-scrollbar-track {
            background: transparent;
          }
          .alert-list-container::-webkit-scrollbar-thumb {
            background: rgba(0,0,0,0.15);
            border-radius: 4px;
          }
          .alert-item-card {
            transition: all 0.2s ease;
          }
          .alert-item-card:hover {
            z-index: 10;
          }
          .metric-widget-box {
            background: transparent;
            border-radius: 16px;
            border: 1px solid transparent;
            transition: border-color 0.2s ease;
          }
          .metric-widget-box:hover {
            border: 1px solid #475467;
          }

          .view-button {
            border: 1px solid transparent !important;
            transition: border-color 0.2s ease;
          }
          .view-button:hover {
            border-color: rgba(0,0,0,0.2) !important;
          }
        `}</style>
        <div className="alert-list-container" style={{ display: "flex", flexDirection: "column", flex: 1, padding: "2px" }}>
          {openAlerts.map((alert, index) => {
            const relTime = index === 0 ? "Just now" : index === 1 ? "2 mins ago" : "5 mins ago";
            
            return (
              <div key={alert.id} className="alert-item-card" style={{
                position: "relative",
                padding: "10px",
                borderRadius: "8px",
                background: "transparent",
                display: "flex",
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "4px",
                cursor: "pointer",
                marginBottom: "6px"
              }}>
                <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <div style={{ fontSize: "15px", fontWeight: 700, color: "#111827", lineHeight: 1.2 }}>{alert.title}</div>
                  </div>
                  
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <div style={{ fontSize: "13px", fontWeight: 600, color: "#667085" }}>{relTime}</div>
                    <div style={{ color: "rgba(0,0,0,0.2)", fontSize: "13px" }}>•</div>
                    <div style={{ fontSize: "13px", color: "#98a2b3" }}>{alert.time}</div>
                  </div>
                </div>
                
                <div style={{ display: "flex", alignItems: "center" }}>
                  <button className="view-button" style={{ fontSize: "13px", fontWeight: 700, padding: "2px 8px", borderRadius: "4px", background: "transparent", cursor: "pointer", color: "#18201f" }}>View</button>
                </div>
              </div>
            );
          })}
          {openAlerts.length === 0 && (
            <div style={{ textAlign: "center", color: "#667085", fontSize: "13px", fontWeight: 600, padding: "32px 0", flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
              No active alerts 
            </div>
          )}
        </div>
      </div>

      {/* Center - Drill-down Chart */}
      <div className="analytics-donut" style={{ gridColumn: 2, gridRow: "1 / -1", alignSelf: "center", justifySelf: "center", width: "100%", height: "auto", aspectRatio: "1/1", maxWidth: "1200px", marginTop: "35px" }}>
        <DrillDownDoughnut data={mockData} />
        <div style={{ position: "absolute", top: "calc(100% + 40px)", left: "50%", transform: "translateX(-50%)", whiteSpace: "nowrap", fontSize: "25px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", color: "#000" }}>Total Scan Breakdown</div>
      </div>

      <div 
        style={{
          position: "absolute",
          bottom: "16px",
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "13px",
          cursor: "pointer",
          zIndex: 10,
        }}
        onClick={() => {
          const tableHeader = Array.from(document.querySelectorAll('h2')).find(h => h.textContent === 'Recent Movement Logs');
          if (tableHeader) {
            tableHeader.scrollIntoView({ behavior: 'smooth' });
          } else {
            const container = document.getElementById("admin-scroll-container");
            if (container) {
              container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
            }
          }
        }}
      >
        <style>{`
          @keyframes scrollWheel {
            0% { transform: translateY(0); opacity: 1; }
            100% { transform: translateY(10px); opacity: 0; }
          }
        `}</style>
        <span style={{
          fontSize: "10px",
          fontWeight: 800,
          letterSpacing: "3px",
          color: "#475467",
          textTransform: "uppercase",
          marginRight: "-3px", /* Compensate for letter spacing to perfectly center */
          textAlign: "center"
        }}>
          Scroll
        </span>
        <div style={{
          width: "18px",
          height: "30px",
          border: "2px solid rgba(253, 176, 34, 0.4)",
          borderRadius: "9px",
          display: "flex",
          justifyContent: "center",
          paddingTop: "4px",
          boxSizing: "border-box",
          boxShadow: "0 0 8px rgba(253, 176, 34, 0.2)"
        }}>
          <div style={{
            width: "3px",
            height: "5px",
            backgroundColor: "#fdb022",
            borderRadius: "1.5px",
            boxShadow: "0 0 4px 1px rgba(253, 176, 34, 0.8)",
            animation: "scrollWheel 1.5s cubic-bezier(0.15, 0.41, 0.69, 0.94) infinite"
          }} />
        </div>
      </div>
    </section>
  );
}
