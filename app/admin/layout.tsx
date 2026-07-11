"use client";

import { ReactNode, useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AppChrome } from "../../components/AppChrome";
import {
  Bell,
  Grid2X2,
  History,
  Heart,
  Package,
  ScanBarcode,
  UserRound,
  UsersRound,
} from "lucide-react";

const adminRailGroups = [
  {
    label: "Operations",
    items: [
      { path: "/admin", icon: Grid2X2, label: "Dashboard", exact: true },
      { path: "/admin/logs", icon: History, label: "Movement Logs" },
      { path: "/admin/alerts", icon: Bell, label: "Alerts" }
    ]
  },
  {
    label: "Types & Forms",
    items: [
      { path: "/admin/employees", icon: UsersRound, label: "Employees" },
      { path: "/admin/visitors", icon: UserRound, label: "Visitors" },
      { path: "/admin/hardware", icon: Package, label: "Hardware" },
      { path: "/admin/barcodes", icon: ScanBarcode, label: "Barcodes" }
    ]
  }
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <AppChrome role="admin">
      <main className="admin-console" style={{ display: "flex", flexDirection: "row", height: "100vh", padding: 0 }}>
        {/* Sidebar Container */}
        <div style={{ flexShrink: 0, width: "72px", position: "relative", zIndex: 50 }}>
          <aside
            onMouseEnter={() => setSidebarOpen(true)}
            onMouseLeave={() => setSidebarOpen(false)}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              bottom: 0,
              width: sidebarOpen ? "250px" : "72px",
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              padding: "0 12px",
              backgroundColor: pathname !== "/admin" && sidebarOpen ? "#D0D8DE" : "transparent",
              borderRight: "none",
              transition: "width 0.3s cubic-bezier(0.2, 0, 0, 1), background-color 0.3s ease",
              overflow: "hidden",
              whiteSpace: "nowrap"
            }}
            aria-label="Admin quick navigation"
          >
            {/* Logo - Top */}
            <div style={{
              position: "absolute",
              top: "16px",
              left: "12px",
              width: "calc(100% - 24px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-start",
              padding: "12px",
            }}>
              <div style={{ width: "24px", display: "flex", justifyContent: "center", alignItems: "center" }}>
                <Heart size={24} strokeWidth={2} />
              </div>
              <span style={{
                marginLeft: "20px",
                fontSize: "15px",
                fontWeight: 800,
                opacity: sidebarOpen ? 1 : 0,
                transition: "opacity 0.2s ease",
                pointerEvents: sidebarOpen ? "auto" : "none",
                color: "rgba(0,0,0,0.85)"
              }}>
                In/Out
              </span>
            </div>

            {/* Top Spacer */}
            <div style={{ flex: 1 }} />

            {/* Nav Icons */}
            <div style={{ display: "flex", flexDirection: "column", gap: pathname === "/admin" ? "3px" : "10px", width: "100%" }}>
              {adminRailGroups.flatMap(group => group.items).map((item) => {
                const Icon = item.icon;
                const active = item.exact ? pathname === item.path : pathname.startsWith(item.path);
                const isAlert = item.path === "/admin/alerts";

                return (
                  <Link
                    key={item.label}
                    href={item.path}
                    onClick={() => setSidebarOpen(false)}
                    title={sidebarOpen ? "" : item.label}
                    style={{
                      background: "none",
                      border: "none",
                      color: active ? "#000" : "rgba(0,0,0,0.65)",
                      cursor: "pointer",
                      position: "relative",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "flex-start",
                      padding: "8px 12px",
                      width: "100%",
                      borderRadius: "12px",
                      transition: "background-color 0.2s ease, transform 0.2s ease",
                      textDecoration: "none"
                    }}
                    onMouseOver={(e) => {
                      e.currentTarget.style.backgroundColor = "rgba(0,0,0,0.06)";
                    }}
                    onMouseOut={(e) => {
                      e.currentTarget.style.backgroundColor = "transparent";
                    }}
                  >
                    <div style={{ width: "24px", display: "flex", justifyContent: "center", alignItems: "center" }}>
                      <Icon size={24} strokeWidth={active ? 2 : 1.25} />
                      {isAlert && (
                        <span style={{
                          position: "absolute",
                          top: "8px",
                          left: "26px",
                          width: "10px",
                          height: "10px",
                          backgroundColor: "#ff3040",
                          borderRadius: "50%",
                          border: "2px solid var(--bg, #121212)"
                        }} />
                      )}
                    </div>
                    <span style={{
                      marginLeft: "20px",
                      fontSize: "15px",
                      fontWeight: active ? 700 : 400,
                      opacity: sidebarOpen ? 1 : 0,
                      transition: "opacity 0.2s ease",
                      pointerEvents: sidebarOpen ? "auto" : "none"
                    }}>
                      {item.label}
                    </span>
                  </Link>
                );
              })}
            </div>

            {/* Bottom Spacer */}
            <div style={{ flex: 1 }} />

            {/* User Profile - Bottom */}
            <button 
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                position: "absolute",
                bottom: "16px",
                left: "12px",
                width: "calc(100% - 24px)",
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-start",
                padding: "12px",
                borderRadius: "12px",
                transition: "background-color 0.2s ease",
              }}
              onMouseOver={(e) => e.currentTarget.style.backgroundColor = "rgba(0,0,0,0.06)"}
              onMouseOut={(e) => e.currentTarget.style.backgroundColor = "transparent"}
              title="Profile"
            >
              <div style={{ width: "24px", display: "flex", justifyContent: "center", alignItems: "center" }}>
                <div style={{
                  width: "24px",
                  height: "24px",
                  borderRadius: "50%",
                  backgroundColor: "#ff7b00",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#fff"
                }}>
                  <UserRound size={16} strokeWidth={2} />
                </div>
              </div>
              <span style={{
                marginLeft: "20px",
                fontSize: "15px",
                fontWeight: 400,
                opacity: sidebarOpen ? 1 : 0,
                transition: "opacity 0.2s ease",
                pointerEvents: sidebarOpen ? "auto" : "none",
                color: "rgba(0,0,0,0.65)"
              }}>
                Profile
              </span>
            </button>
          </aside>
        </div>

        <div style={{ flex: 1, position: "relative", width: "auto", height: "100vh", overflowY: "auto" }}>
          {children}
        </div>
      </main>
    </AppChrome>
  );
}
