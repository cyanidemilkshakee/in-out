"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, LoaderCircle, RotateCw, ShieldCheck } from "lucide-react";
import type { EntryRestrictionDirectory, EntryRestrictionDirectoryItem } from "../../../lib/types";
import { DataServiceError, HttpDataService } from "../../../services/httpDataService";
import styles from "./MasterEntryRestrictions.module.css";

const PAGE_SIZE = 25;
const dataService = new HttpDataService();

function message(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function triggeredDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown date" : new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata",
  }).format(date);
}

export function MasterEntryRestrictions() {
  const [page, setPage] = useState<EntryRestrictionDirectory | null>(null);
  const [offset, setOffset] = useState(0);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [messageText, setMessageText] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const loadPage = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const result = await dataService.queryEntryRestrictions({ limit: PAGE_SIZE, offset }, signal);
      if (!signal?.aborted && result.total > 0 && offset >= result.total) {
        setOffset(Math.floor((result.total - 1) / PAGE_SIZE) * PAGE_SIZE);
      } else if (!signal?.aborted) {
        setPage(result);
      }
    } catch (cause) {
      if (!signal?.aborted) setError(message(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [offset]);

  useEffect(() => {
    const controller = new AbortController();
    void loadPage(controller.signal);
    return () => controller.abort();
  }, [loadPage, refreshKey]);

  async function release(event: FormEvent<HTMLFormElement>, item: EntryRestrictionDirectoryItem) {
    event.preventDefault();
    const reason = reasons[item.triggerAlertId]?.trim() ?? "";
    if (!reason || busyId) return;
    setBusyId(item.triggerAlertId);
    setError("");
    setMessageText("");
    try {
      await dataService.releaseEntryRestriction(item.triggerAlertId, reason);
      setMessageText(`Entry restriction released for ${item.subjectName}.`);
      setReasons((current) => { const next = { ...current }; delete next[item.triggerAlertId]; return next; });
      setRefreshKey((current) => current + 1);
    } catch (cause) {
      setError(cause instanceof DataServiceError ? cause.message : message(cause));
    } finally {
      setBusyId("");
    }
  }

  const items = page?.items ?? [];
  const total = page?.total ?? 0;
  const hasPrevious = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  return <main className={styles.page} aria-label="Entry restriction escalation">
    <header className={styles.header}>
      <div>
        <h1>Entry restrictions</h1>
        <p>Review active entry holds that span zones. Releasing a hold does not change the original alert or access grant.</p>
      </div>
      <button type="button" className={styles.refresh} onClick={() => setRefreshKey((current) => current + 1)} disabled={loading}>
        {loading ? <LoaderCircle size={17} className={styles.spinner} aria-hidden="true" /> : <RotateCw size={17} aria-hidden="true" />}
        Refresh
      </button>
    </header>

    {error && <p className={styles.error} role="alert">{error}</p>}
    {messageText && <p className={styles.success} role="status"><ShieldCheck size={17} aria-hidden="true" />{messageText}</p>}

    <section className={styles.directory} aria-label="Active entry restrictions" aria-busy={loading || Boolean(busyId)}>
      <div className={styles.directoryHeader}>
        <div><h2>Active holds</h2><p>Only active entry restrictions are listed here.</p></div>
        <span className={styles.count}>{total}</span>
      </div>
      {loading ? <p className={styles.state}><LoaderCircle size={18} className={styles.spinner} aria-hidden="true" />Loading active restrictions…</p>
        : !items.length ? <div className={styles.empty}><ShieldCheck size={24} aria-hidden="true" /><strong>No active entry restrictions</strong><span>There are no cross-zone holds that need escalation.</span></div>
          : <div className={styles.rows}>{items.map((item) => <article className={styles.row} key={item.triggerAlertId}>
            <div className={styles.identity}>
              <span className={styles.icon}><AlertTriangle size={19} aria-hidden="true" /></span>
              <div><h3>{item.subjectName}</h3><p>{item.subjectType} · {item.barcode}</p><time dateTime={item.triggeredAt}>Held since {triggeredDate(item.triggeredAt)}</time></div>
            </div>
            <div className={styles.zones}><span className={styles.label}>Affected zones</span>
              {item.zones.length ? <div className={styles.tags}>{item.zones.map((zone, index) => <span className={styles.tag} key={`${item.zoneIds[index] ?? zone}-${index}`}>{zone}</span>)}</div>
                : <span className={styles.legacy}>Zone scope was not recorded for this hold.</span>}
            </div>
            <form className={styles.releaseForm} onSubmit={(event) => void release(event, item)}>
              <label htmlFor={`release-reason-${item.triggerAlertId}`}>Reason to release</label>
              <div className={styles.releaseControls}>
                <input id={`release-reason-${item.triggerAlertId}`} value={reasons[item.triggerAlertId] ?? ""}
                  onChange={(event) => setReasons((current) => ({ ...current, [item.triggerAlertId]: event.target.value }))}
                  maxLength={1000} required placeholder="Explain why the hold can be lifted" disabled={Boolean(busyId)} />
                <button type="submit" disabled={!reasons[item.triggerAlertId]?.trim() || Boolean(busyId)}>
                  {busyId === item.triggerAlertId ? <LoaderCircle size={16} className={styles.spinner} aria-hidden="true" /> : <ShieldCheck size={16} aria-hidden="true" />}
                  {busyId === item.triggerAlertId ? "Releasing…" : "Release hold"}
                </button>
              </div>
            </form>
          </article>)}</div>}
      {total > PAGE_SIZE && <nav className={styles.pagination} aria-label="Restriction pages">
        <span>{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}</span>
        <div><button type="button" aria-label="Previous page" disabled={!hasPrevious || loading} onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}><ChevronLeft size={18} /></button>
          <button type="button" aria-label="Next page" disabled={!hasNext || loading} onClick={() => setOffset((current) => current + PAGE_SIZE)}><ChevronRight size={18} /></button></div>
      </nav>}
    </section>
  </main>;
}
