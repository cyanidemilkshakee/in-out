"use client";

import { useState, type CSSProperties, type FocusEvent } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  BookUser,
  Grid2X2,
  Heart,
  History,
  Key,
  UserCog,
} from "lucide-react";

const navigationItems = [
  { path: "/admin/dashboard", icon: Grid2X2, label: "Dashboard", exact: true },
  { path: "/admin/logs", icon: History, label: "Movement Logs" },
  { path: "/admin/permissions", icon: Key, label: "Permission Manager" },
  { path: "/admin/alerts", icon: Bell, label: "Alerts" },
  { path: "/admin/registry", icon: BookUser, label: "Registry" },
];

export function AdminNavRail({ scrollTint }: { scrollTint: number }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const isDashboard = pathname === "/admin/dashboard";
  const railStyle = {
    "--admin-rail-tint": `${Math.round(scrollTint * 100)}%`,
  } as CSSProperties;

  function handleBlur(event: FocusEvent<HTMLElement>) {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }

  return (
    <div className="admin-rail-slot">
      <aside
        className={`admin-navigation-rail${open ? " is-open" : ""}${isDashboard ? " is-dashboard" : ""}`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocusCapture={() => setOpen(true)}
        onBlurCapture={handleBlur}
        style={railStyle}
        aria-label="Admin quick navigation"
      >
        <Link
          href="/admin/dashboard"
          className="admin-rail-brand"
          onClick={() => setOpen(false)}
          aria-label="In/Out dashboard"
        >
          <span className="admin-rail-icon">
            <Heart size={24} strokeWidth={2} />
          </span>
          <span className="admin-rail-link-label">In/Out</span>
        </Link>

        <nav className="admin-rail-items" aria-label="Administration">
          {navigationItems.map((item) => {
            const Icon = item.icon;
            const active = item.exact
              ? pathname === item.path
              : pathname.startsWith(item.path);
            return (
              <Link
                key={item.label}
                href={item.path}
                onClick={() => setOpen(false)}
                title={open ? "" : item.label}
                className="nav-rail-link"
                aria-current={active ? "page" : undefined}
                aria-label={item.label}
              >
                <span className="admin-rail-icon">
                  <Icon size={24} strokeWidth={active ? 2 : 1.25} />
                  {item.path === "/admin/alerts" ? (
                    <span className="admin-alert-dot" aria-hidden="true" />
                  ) : null}
                </span>
                <span className="admin-rail-link-label">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <Link
          href="/admin/profile"
          onClick={() => setOpen(false)}
          className="nav-rail-link admin-rail-profile"
          aria-current={pathname === "/admin/profile" ? "page" : undefined}
          aria-label="Profile"
          title={open ? "" : "Profile"}
        >
          <span className="admin-rail-icon">
            <span className="admin-profile-avatar">
              <UserCog size={16} strokeWidth={2} />
            </span>
          </span>
          <span className="admin-rail-link-label">Profile</span>
        </Link>
      </aside>
    </div>
  );
}
