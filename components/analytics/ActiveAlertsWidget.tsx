"use client";

import { ChevronRight } from "lucide-react";
import type { Alert } from "../../lib/types";

type ActiveAlertsWidgetProps = {
  openAlerts: Alert[];
};

export function ActiveAlertsWidget({ openAlerts }: ActiveAlertsWidgetProps) {
  return (
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
          border: 1px solid rgba(71, 84, 103, 0.4);
        }
        .alert-widget-header {
          border-bottom: 1px solid transparent;
          transition: border-color 0.2s ease;
        }
        .alert-widget-box:hover .alert-widget-header {
          border-bottom: 1px solid rgba(71, 84, 103, 0.4);
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
          transition: border-color 80ms linear, background-color 80ms linear;
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
          border: 1px solid rgba(71, 84, 103, 0.4);
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
  );
}
