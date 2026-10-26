"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Alert, AlertRule, AlertRuleAssignment, AlertWarningSummary, Person } from "../../../lib/types";
import { useDataActions } from "../../context/DataContext";
import { parsePresenceUpdate } from "../../context/presenceUpdates";
import { AlertActivity } from "./alerts/AlertActivity";
import { RuleAssignments } from "./alerts/RuleAssignments";
import { WarningSummary } from "./alerts/WarningSummary";
import { ScheduledIrregularitySkips } from "./alerts/ScheduledIrregularitySkips";
import { getAlertReviewState } from "./alerts/alertPresentation";
import styles from "./EmployeeProfileAlerts.module.css";

export function EmployeeProfileAlerts({ person, initialAlerts, showHistory }: {
  person: Person;
  initialAlerts: Alert[];
  showHistory: boolean;
}) {
  const { queryAlerts, reviewAlert, resetAlertWarnings, setAlertRuleAssignments } = useDataActions();
  const [alerts, setAlerts] = useState(initialAlerts);
  const [warnings, setWarnings] = useState<AlertWarningSummary[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [assignments, setAssignments] = useState<AlertRuleAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");
  const [openOffset, setOpenOffset] = useState(0);
  const [openTotal, setOpenTotal] = useState(0);
  const [reviewedAlerts, setReviewedAlerts] = useState<Alert[]>([]);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyRevision, setHistoryRevision] = useState(0);
  const loadController = useRef<AbortController | null>(null);
  const mutationPending = useRef(false);

  const reload = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setError("");
    try {
      const firstPage = await queryAlerts({ view: "subject", reviewState: "needs_review", subjectId: person.id,
        limit: 25, offset: openOffset, sortDirection: "asc" }, controller.signal);
      controller.signal.throwIfAborted();
      setAlerts([...firstPage.items, ...(firstPage.currentWarnings ?? [])]);
      setOpenTotal(firstPage.total);
      if (openOffset >= firstPage.total && openOffset > 0) setOpenOffset(Math.max(0, Math.ceil(firstPage.total / 25) - 1) * 25);
      const subjectWarnings = (firstPage.warnings ?? []).filter((summary) => summary.subjectId === person.id);
      setWarnings(subjectWarnings);
      setRules(firstPage.rules ?? []);
      setAssignments(firstPage.assignments ?? []);
      setHistoryRevision(value => value + 1);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "Unable to load employee alerts.");
        throw cause;
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [person.id, queryAlerts, openOffset]);

  useEffect(() => {
    if (!showHistory) return;
    const controller = new AbortController();
    setHistoryLoading(true);
    setHistoryError("");
    void queryAlerts({ view: "subject", reviewState: "reviewed", subjectId: person.id,
      limit: 25, offset: historyOffset, sortDirection: "desc" }, controller.signal)
      .then(result => { if (!controller.signal.aborted) { setReviewedAlerts(result.items); setHistoryTotal(result.total); } })
      .catch(cause => { if (!controller.signal.aborted) setHistoryError(cause instanceof Error ? cause.message : "Unable to load reviewed alerts."); })
      .finally(() => { if (!controller.signal.aborted) setHistoryLoading(false); });
    return () => controller.abort();
  }, [showHistory, historyOffset, historyRevision, person.id, queryAlerts]);

  useEffect(() => {
    void reload().catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    function scheduleReload() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void reload().catch(() => {}); }, 300);
    }
    function onMessage(event: Event) {
      const raw = (event as CustomEvent<unknown>).detail;
      if (typeof raw !== "string") return;
      try {
        const update = parsePresenceUpdate(raw);
        if (update?.type === "data_changed" || update?.alerts?.some((alert) =>
          alert.subjectId === person.id || (!alert.subjectId && alert.barcode.toLowerCase() === person.barcode.toLowerCase()))) {
          scheduleReload();
        }
      } catch { /* A malformed live event must not interrupt profile controls. */ }
    }
    function onVisibility() {
      if (document.visibilityState === "visible") scheduleReload();
    }
    window.addEventListener("inout:presence-message", onMessage);
    window.addEventListener("inout:presence-sync", scheduleReload);
    window.addEventListener("focus", scheduleReload);
    window.addEventListener("online", scheduleReload);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      loadController.current?.abort();
      if (timer) clearTimeout(timer);
      window.removeEventListener("inout:presence-message", onMessage);
      window.removeEventListener("inout:presence-sync", scheduleReload);
      window.removeEventListener("focus", scheduleReload);
      window.removeEventListener("online", scheduleReload);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reload, person.id, person.barcode]);

  // A failed refresh after a successful mutation should offer a reload, not report
  // that the review/reset failed and encourage the administrator to repeat it.
  async function mutate<T,>(action: () => Promise<T>): Promise<T> {
    if (mutationPending.current) throw new Error("An alert change is already being saved.");
    mutationPending.current = true;
    setMutating(true);
    try {
      const saved = await action();
      await reload().catch(() => {});
      return saved;
    } finally {
      mutationPending.current = false;
      setMutating(false);
    }
  }

  const openAlerts = useMemo(() => alerts.filter((alert) => getAlertReviewState(alert) === "needs_review"), [alerts]);
  const subject = { subjectId: person.id, subjectName: person.name, subjectType: person.type, barcode: person.barcode, status: person.status };
  const busy = loading || mutating;
  const controlsDisabled = busy || Boolean(error);
  const warningSummary = <WarningSummary warnings={warnings} alerts={alerts} selectedSubject={subject} isLoading={controlsDisabled}
    onReset={(subjectId, reason) => mutate(() => resetAlertWarnings(subjectId, reason))}
    showHistoryAction={false} hideWarningEmptyText className="employee-profile-warning-summary" />;

  return <aside className={`${styles.panel} employee-profile-alerts-panel scrollable-content`} aria-label={`Alerts and rules for ${person.name}`}>
    {error && <div className={styles.error} role="status"><p>{error}</p><button type="button" disabled={loading || mutating} onClick={() => void reload().catch(() => {})}>Reload alerts</button></div>}
    <div className={`${styles.controls} employee-profile-utilities`}>
      {person.type === "employee" ? <div className={`${styles.assignmentStack} employee-profile-assignment-stack`}>
        <RuleAssignments assignments={assignments} rules={rules} selectedEmployeeId={person.id} isLoading={controlsDisabled}
          onSave={(subjectId, ruleIds, skipDates, revision) => mutate(() => setAlertRuleAssignments(subjectId, ruleIds, skipDates, revision))}
          onReload={reload} profileLayout
          profileSchedule={<ScheduledIrregularitySkips assignments={assignments.filter((assignment) => assignment.subjectId === person.id)} variant="profile" />}>
          {warningSummary}
        </RuleAssignments>
      </div> : <section className={`${styles.visitorWarnings} employee-profile-rules-card`} aria-label="Warnings">{warningSummary}</section>}
    </div>
    <section id="employee-profile-alert-history" className={`${styles.openAlertsBox} employee-profile-open-alerts-card`} aria-label={showHistory ? "Alert history" : "Open alerts"}>
      <div className={styles.openAlertsHeading}>
        <h3>{showHistory ? "Alert history" : "Open alerts"}</h3>
        <span>{showHistory ? historyTotal : openTotal}</span>
      </div>
      {showHistory ? <>
        {historyError ? <p role="alert">{historyError}</p> : null}
        <AlertActivity className={styles.activity} alerts={reviewedAlerts} people={[person]} filter="all" isLoading={historyLoading}
          title="Reviewed alerts and saved notes"
          showSubjectDetails={false} showDescription={false}
          emptyMessage="No reviewed alerts for this employee."
          onReview={(alertId, decision, reason) => mutate(() => reviewAlert(alertId, decision, reason))} />
        {historyTotal > 25 ? <div className="pagination"><button type="button" disabled={!historyOffset || historyLoading} onClick={() => setHistoryOffset(value => Math.max(0, value - 25))}>Previous</button>
          <span>Page {Math.floor(historyOffset / 25) + 1} of {Math.ceil(historyTotal / 25)}</span><button type="button" disabled={historyLoading || historyOffset + 25 >= historyTotal} onClick={() => setHistoryOffset(value => value + 25)}>Next</button></div> : null}
      </> : <>
        <AlertActivity className={styles.activity} alerts={openAlerts} people={[person]} filter="needs_review" isLoading={busy} disabled={controlsDisabled}
          title="Review alerts in chronological order"
          totalCount={openTotal}
          showSubjectDetails={false} showDescription={false} showWarningLimitMessage={false}
          emptyMessage="No open alerts for this employee."
          onReview={(alertId, decision, reason) => mutate(() => reviewAlert(alertId, decision, reason))} />
        {openTotal > 25 ? <div className="pagination"><button type="button" disabled={!openOffset || busy} onClick={() => setOpenOffset(value => Math.max(0, value - 25))}>Previous</button>
          <span>Page {Math.floor(openOffset / 25) + 1} of {Math.ceil(openTotal / 25)}</span><button type="button" disabled={busy || openOffset + 25 >= openTotal} onClick={() => setOpenOffset(value => value + 25)}>Next</button></div> : null}
      </>}
    </section>
  </aside>;
}
