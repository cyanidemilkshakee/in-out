"use client";

import { ReactNode, useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AppChrome } from "../../components/AppChrome";
import {
  Bell,
  Grid2X2,
  History,
  Heart,
  Package,
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
      { path: "/admin/hardware", icon: Package, label: "Hardware" }
    ]
  }
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [scrollTint, setScrollTint] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const scrolledRef = useRef(false);
  const scrollTintRef = useRef(0);

  const handleScroll = useCallback(() => {
    if (rafRef.current !== null) return; // already scheduled
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const next = (scrollRef.current?.scrollTop ?? 0) > 100;
      const scrollTop = scrollRef.current?.scrollTop ?? 0;
      const nextTint = Math.min(1, Math.max(0, scrollTop / 180));
      if (next !== scrolledRef.current) {
        scrolledRef.current = next;
        setScrolled(next);
      }
      if (Math.abs(nextTint - scrollTintRef.current) > 0.04 || nextTint === 0 || nextTint === 1) {
        scrollTintRef.current = nextTint;
        setScrollTint(nextTint);
      }
    });
  }, []);

  useEffect(() => {
    const storedTheme = window.localStorage.getItem("inout-admin-theme");
    if (storedTheme === "light" || storedTheme === "dark") {
      document.documentElement.dataset.adminTheme = storedTheme;
    } else {
      document.documentElement.dataset.adminTheme = "light";
      window.localStorage.setItem("inout-admin-theme", "light");
    }
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", handleScroll);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [handleScroll]);

  return (
    <AppChrome role="admin">
      {/* One-time CSS injection — no JS on hover */}
      <style>{`
        .nav-rail-link { transition: background-color 0.15s ease; }
        .nav-rail-link:hover { background-color: var(--admin-panel); }
      `}</style>
      <main className="admin-console" style={{ display: "flex", flexDirection: "row", height: "100vh", padding: 0 }}>
        {/* Sidebar Container */}
        <div style={{ flexShrink: 0, width: "72px", position: "relative", zIndex: 50, backgroundColor: "var(--admin-bg)" }}>
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
              backgroundColor: pathname === "/admin"
                ? `color-mix(in srgb, var(--admin-bg) ${Math.round(scrollTint * 100)}%, transparent)`
                : sidebarOpen ? "var(--admin-surface-strong)" : "transparent",
              borderRight: "none",
              transition: "width 0.22s cubic-bezier(0.2, 0, 0, 1), background-color 0.22s ease",
              willChange: "width",
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
                color: "var(--admin-text)"
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
                    className="nav-rail-link"
                    style={{
                      background: "none",
                      border: "none",
                      color: active ? "var(--admin-text)" : "var(--admin-muted)",
                      cursor: "pointer",
                      position: "relative",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "flex-start",
                      padding: "8px 12px",
                      width: "100%",
                      borderRadius: "12px",
                      textDecoration: "none"
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
                          border: "2px solid var(--admin-bg, #121212)"
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
            <Link
              href="/admin/profile"
              onClick={() => setSidebarOpen(false)}
              className="nav-rail-link"
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
              }}
              title="Profile"
            >
              <div style={{ width: "24px", display: "flex", justifyContent: "center", alignItems: "center" }}>
                <div style={{
                  width: "24px",
                  height: "24px",
                  borderRadius: "50%",
                  backgroundColor: "var(--admin-lime)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--admin-text)"
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
                color: "var(--admin-muted)"
              }}>
                Profile
              </span>
            </Link>
          </aside>
        </div>

        <div 
          id="admin-scroll-container"
          ref={scrollRef}
          className={scrolled ? "scrolled-main-content" : "top-main-content"}
          style={{
            flex: 1,
            position: "relative",
            width: "auto",
            height: "100vh",
            overflowY: "auto",
            overscrollBehavior: "none",
            touchAction: "pan-y",
          }}
        >
          {children}
        </div>
      </main>
    </AppChrome>
  );
}
