"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { HttpDataService } from "../../../services/httpDataService";
import { createRefreshCoordinator } from "../../../lib/refreshCoordinator";

const service = new HttpDataService();
const OpenAlertCountContext = createContext<number | null>(null);

export function AdminLiveProvider({ children }: { children: ReactNode }) {
  const [openAlertCount, setOpenAlertCount] = useState(0);
  const requestVersion = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [resume, setResume] = useState<{ revision?: number; scope?: string; generation: number }>({ generation: 0 });
  const latestRevision = useRef<number | undefined>(undefined);
  const activeScope = useRef<string | undefined>(undefined);
  const needsSnapshot = useRef(false);
  const awaitingSnapshot = useRef(false);

  useEffect(() => {
    const register = (event: Event) => {
      const detail = (event as CustomEvent<{ revision: number; scope: string }>).detail;
      if (!detail || !Number.isSafeInteger(detail.revision) || detail.revision < 0) return;
      awaitingSnapshot.current = false;
      if (needsSnapshot.current || activeScope.current !== detail.scope || latestRevision.current === undefined || detail.revision > latestRevision.current) {
        activeScope.current = detail.scope;
        latestRevision.current = detail.revision;
        needsSnapshot.current = false;
        setResume(previous => ({ ...detail, generation: previous.generation + 1 }));
      }
    };
    const pending = () => { awaitingSnapshot.current = true; };
    window.addEventListener("inout:snapshot-revision", register);
    window.addEventListener("inout:snapshot-pending", pending);
    return () => {
      window.removeEventListener("inout:snapshot-revision", register);
      window.removeEventListener("inout:snapshot-pending", pending);
    };
  }, []);

  const refreshAlerts = useMemo(() => createRefreshCoordinator(async () => {
    const version = ++requestVersion.current;
    try {
      const next = await service.queryOpenAlertCount();
      if (version === requestVersion.current) setOpenAlertCount(next);
    } catch {
      // Preserve the last confirmed count while the connection recovers.
    }
  }), []);

  useEffect(() => {
    const source = new EventSource(resume.revision === undefined ? "/api/presence" : `/api/presence?since=${resume.revision}`);
    let initialCountRequested = false;
    const loadInitialCount = () => {
      if (initialCountRequested) return;
      initialCountRequested = true;
      void refreshAlerts.request(true);
    };
    // Read once after the stream opens so the initial count covers the setup
    // gap. Fall back when SSE is slow or unavailable instead of blocking it.
    const initialTimer = setTimeout(loadInitialCount, 1_000);
    const scheduleRefresh = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void refreshAlerts.request(true), 200);
    };
    source.onopen = () => {
      clearTimeout(initialTimer);
      initialCountRequested = true;
      void refreshAlerts.request(true);
      // Sync the scoped snapshot after the first connection as well as after
      // reconnects, so events between SSR and SSE setup cannot leave stale UI.
      if (resume.revision === undefined && !awaitingSnapshot.current) window.dispatchEvent(new Event("inout:presence-sync"));
    };
    source.onerror = loadInitialCount;
    source.onmessage = event => {
      try {
        const revision = JSON.parse(event.data).revision;
        if (Number.isSafeInteger(revision)) latestRevision.current = revision;
      } catch { /* Normal parsing below also discards malformed messages. */ }
      window.dispatchEvent(new CustomEvent("inout:presence-message", { detail: event.data }));
      try {
        const update = JSON.parse(event.data);
        if (update.alerts || update.type === "data_changed") scheduleRefresh();
      } catch { /* Ignore malformed stream messages. */ }
    };
    const advanceCursor = (event: Event) => {
      try {
        const revision = JSON.parse((event as MessageEvent<string>).data).revision;
        if (Number.isSafeInteger(revision)) latestRevision.current = revision;
      } catch { /* Ignore invalid control frames. */ }
    };
    const snapshotRequired = () => {
      needsSnapshot.current = true;
      source.close();
      window.dispatchEvent(new Event("inout:presence-sync"));
    };
    const recoveryTimer = setInterval(() => {
      if (needsSnapshot.current) window.dispatchEvent(new Event("inout:presence-sync"));
    }, 5_000);
    source.addEventListener("ready", advanceCursor);
    source.addEventListener("cursor", advanceCursor);
    source.addEventListener("snapshot_required", snapshotRequired);
    const onFocus = () => void refreshAlerts.request();
    window.addEventListener("inout:alerts-changed", scheduleRefresh);
    window.addEventListener("focus", onFocus);
    return () => {
      source.close();
      clearTimeout(initialTimer);
      clearInterval(recoveryTimer);
      clearTimeout(timer.current);
      refreshAlerts.clearPending();
      requestVersion.current++;
      window.removeEventListener("inout:alerts-changed", scheduleRefresh);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshAlerts, resume]);

  return <OpenAlertCountContext.Provider value={openAlertCount}>{children}</OpenAlertCountContext.Provider>;
}

export function useOpenAlertCount() {
  const count = useContext(OpenAlertCountContext);
  if (count === null) throw new Error("Open alert count requires AdminLiveProvider");
  return count;
}
