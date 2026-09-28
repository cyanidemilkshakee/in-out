"use client";

import { useState, type CSSProperties, type FocusEvent } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, BookUser, Clock3, Grid2X2, Heart, History, Key, LogOut, UserCog, UsersRound } from "lucide-react";
import { beginLogout } from "../../../app/authActions";

const navigationItems = [
  { path: "/admin/dashboard", icon: Grid2X2, label: "Dashboard", exact: true },
  { path: "/admin/logs", icon: History, label: "Movement Logs" },
  { path: "/admin/permissions", icon: Key, label: "Permission Manager" },
  { path: "/admin/alerts", icon: Bell, label: "Alerts" },
  { path: "/admin/registry", icon: BookUser, label: "Registry" },
];

const returnOptions = [
  { minutes: 15, label: "About 15 minutes" }, { minutes: 30, label: "About 30 minutes" },
  { minutes: 60, label: "About 1 hour" }, { minutes: 120, label: "About 2 hours" }, { minutes: 240, label: "About 4 hours" },
];

function returnTime(minutes: number) {
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(Date.now() + minutes * 60_000));
}

export function AdminNavRail({ scrollTint }: { scrollTint: number }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [offlineMinutes, setOfflineMinutes] = useState(30);
  const isDashboard = pathname === "/admin/dashboard";
  const railStyle = { "--admin-rail-tint": `${Math.round(scrollTint * 100)}%` } as CSSProperties;
  const closeAccountMenu = () => setAccountOpen(false);

  function handleBlur(event: FocusEvent<HTMLElement>) {
    if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); closeAccountMenu(); }
  }

  return <><div className="admin-rail-slot"><aside
    className={`admin-navigation-rail${open || accountOpen ? " is-open" : ""}${isDashboard ? " is-dashboard" : ""}`}
    onMouseEnter={() => setOpen(true)} onMouseLeave={() => { setOpen(false); closeAccountMenu(); }} onFocusCapture={() => setOpen(true)} onBlurCapture={handleBlur} style={railStyle} aria-label="Admin quick navigation"
  >
    <Link href="/admin/dashboard" className="admin-rail-brand" onClick={() => setOpen(false)} aria-label="In/Out dashboard"><span className="admin-rail-icon"><Heart size={24} strokeWidth={2} /></span><span className="admin-rail-link-label">In/Out</span></Link>
    <nav className="admin-rail-items" aria-label="Administration">
      {navigationItems.map((item) => {
        const Icon = item.icon; const active = item.exact ? pathname === item.path : pathname.startsWith(item.path);
        return <Link key={item.label} href={item.path} onClick={() => setOpen(false)} title={open ? "" : item.label} className="nav-rail-link" aria-current={active ? "page" : undefined} aria-label={item.label}><span className="admin-rail-icon"><Icon size={24} strokeWidth={active ? 2 : 1.25} />{item.path === "/admin/alerts" ? <span className="admin-alert-dot" aria-hidden="true" /> : null}</span><span className="admin-rail-link-label">{item.label}</span></Link>;
      })}
    </nav>
    <div className="admin-rail-account">
      {accountOpen ? <section id="admin-account-menu" className="admin-account-menu" aria-label="Account menu">
        <div className="admin-account-menu-heading"><UserCog size={16} aria-hidden="true" /><span>Account</span></div>
        <div className="admin-account-menu-links"><Link href="/admin/profile" onClick={closeAccountMenu}><UserCog size={16} aria-hidden="true" /> Manage profile</Link><Link href="/admin/users" onClick={closeAccountMenu}><UsersRound size={16} aria-hidden="true" /> Manage users</Link></div>
        <button className="admin-account-signout" type="button" onClick={() => { setAccountOpen(false); setConfirmingLogout(true); }}><LogOut size={16} aria-hidden="true" /> Sign out</button>
      </section> : null}
      <button type="button" onClick={() => { setAccountOpen((current) => !current); setOpen(true); }} className="nav-rail-link admin-rail-profile admin-rail-account-trigger" aria-expanded={accountOpen} aria-controls="admin-account-menu" aria-label="Open account menu" title={open ? "" : "Account menu"}><span className="admin-rail-icon"><span className="admin-profile-avatar"><UserCog size={16} strokeWidth={2} /></span></span><span className="admin-rail-link-label">Account</span></button>
    </div>
  </aside></div>
  {confirmingLogout ? <div className="admin-signout-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmingLogout(false); }}>
    <form action={beginLogout} className="admin-signout-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-signout-title">
      <div className="admin-account-menu-heading"><Clock3 size={18} aria-hidden="true" /><span id="admin-signout-title">Sign out</span></div>
      <p>Let operators know when manual reviews may be picked up while you are away.</p>
      <label>Expected return<select name="offlineDurationMinutes" value={offlineMinutes} onChange={(event) => setOfflineMinutes(Number(event.target.value))}>{returnOptions.map((option) => <option key={option.minutes} value={option.minutes}>{option.label}</option>)}</select></label>
      <small>Approximately {returnTime(offlineMinutes)} IST</small>
      <button className="admin-account-signout" type="submit"><LogOut size={16} aria-hidden="true" /> Sign out</button>
    </form>
  </div> : null}</>;
}
