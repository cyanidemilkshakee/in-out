"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { HttpDataService } from "../../../services/httpDataService";

const service = new HttpDataService();
const OpenAlertCountContext = createContext<number | null>(null);

export function AdminLiveProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [openAlertCount, setOpenAlertCount] = useState(0);
  const requestVersion = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refreshAlerts = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const next = await service.queryOpenAlertCount();
      if (version === requestVersion.current) setOpenAlertCount(next);
    } catch {
      // Preserve the last confirmed count while the connection recovers.
    }
  }, []);

  useEffect(() => { void refreshAlerts(); }, [pathname, refreshAlerts]);

  useEffect(() => {
    const source = new EventSource("/api/presence");
    const scheduleRefresh = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void refreshAlerts(), 200);
    };
    source.onopen = () => {
      void refreshAlerts();
      // Sync the scoped snapshot after the first connection as well as after
      // reconnects, so events between SSR and SSE setup cannot leave stale UI.
      window.dispatchEvent(new Event("inout:presence-sync"));
    };
    source.onmessage = event => {
      window.dispatchEvent(new CustomEvent("inout:presence-message", { detail: event.data }));
      try {
        const update = JSON.parse(event.data);
        if (update.alerts || update.type === "data_changed") scheduleRefresh();
      } catch { /* Ignore malformed stream messages. */ }
    };
    const onFocus = () => void refreshAlerts();
    window.addEventListener("inout:alerts-changed", scheduleRefresh);
    window.addEventListener("focus", onFocus);
    return () => {
      source.close();
      clearTimeout(timer.current);
      requestVersion.current++;
      window.removeEventListener("inout:alerts-changed", scheduleRefresh);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshAlerts]);

  return <OpenAlertCountContext.Provider value={openAlertCount}>{children}</OpenAlertCountContext.Provider>;
}

export function useOpenAlertCount() {
  const count = useContext(OpenAlertCountContext);
  if (count === null) throw new Error("Open alert count requires AdminLiveProvider");
  return count;
}
