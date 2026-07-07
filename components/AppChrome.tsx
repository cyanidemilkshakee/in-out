"use client";

import Link from "next/link";
import { ShieldCheck, UserRound } from "lucide-react";
import type { Role } from "../lib/types";

type AppChromeProps = {
  role: Role;
  children: React.ReactNode;
};

export function AppChrome({ role, children }: AppChromeProps) {
  const isAdmin = role === "admin";

  return (
    <div className={`app-shell role-${role}`}>
      {!isAdmin ? (
        <header className="topbar">
          <div className="brand-block">
            <Link href="/admin" className="brand">
              IN / OUT
            </Link>
            <span>Management System</span>
          </div>
          <nav className="topbar-actions" aria-label="Application surfaces">
            <Link className="surface-link" href="/admin">
              <ShieldCheck />
              Admin Console
            </Link>
            <Link className="surface-link active" href="/terminal">
              <UserRound />
              Security Terminal
            </Link>
            <div className="session-chip" title="OAuth 2.0 + OIDC role session simulation">
              <span className="session-avatar">ST</span>
              <span>
                <strong>Security Staff</strong>
                <small>terminal@company.com</small>
              </span>
            </div>
          </nav>
        </header>
      ) : null}
      {children}
    </div>
  );
}
