"use client";

import { useEffect } from "react";
import type { Role } from "../lib/types";

type AppChromeProps = {
  role: Role;
  children: React.ReactNode;
};

export function AppChrome({ role, children }: AppChromeProps) {
  useEffect(() => {
    const storedTheme = window.localStorage.getItem("inout-admin-theme");
    document.documentElement.dataset.adminTheme =
      storedTheme === "dark" ? "dark" : "light";
  }, []);

  return (
    <div className={`app-shell role-${role}`}>
      {children}
    </div>
  );
}
