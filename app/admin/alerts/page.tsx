"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AlertPage } from "../../../lib/types";
import { AdminPageFrame } from "../../../frontend/components/admin/tables/AdminPageFrame";
import { AlertActivity } from "../../../frontend/components/admin/alerts/AlertActivity";
import { AutomatedRules } from "../../../frontend/components/admin/alerts/AutomatedRules";
import { EmployeeAlertManagement } from "../../../frontend/components/admin/alerts/EmployeeAlertManagement";
import { ScheduledIrregularitySkips } from "../../../frontend/components/admin/alerts/ScheduledIrregularitySkips";
import { getAlertReviewState } from "../../../frontend/components/admin/alerts/alertPresentation";
import { useDataActions, useDataState } from "../../../frontend/context/DataContext";
import styles from "./AlertsPage.module.css";

export default function AlertsPage() {
  const { alerts, alertRules, alertWarnings, alertRuleAssignments, alertSummary, people, permissions, movements, isLoading, error } = useDataState();
  const { reviewAlert, resetAlertWarnings, setAlertRuleAssignments, evaluateAlertRules, refresh, queryAlerts } = useDataActions();
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [evaluationMessage, setEvaluationMessage] = useState("");
  const evaluationPending = useRef(false);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<AlertPage | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState("");
  const pageSize = 50;
  useEffect(() => {
    setPage(null);
    setPageError("");
    if (offset === 0) { setPageLoading(false); return; }
    const controller = new AbortController();
    setPageLoading(true);
    void queryAlerts({ view: "command", limit: pageSize, offset, sortDirection: "asc" }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (offset >= result.total && result.total > 0) {
          setOffset(Math.floor((result.total - 1) / pageSize) * pageSize);
          return;
        }
        if (result.total === 0) setOffset(0);
        setPage(result);
      })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setPageError(cause instanceof Error ? cause.message : "Unable to load alerts."); })
      .finally(() => { if (!controller.signal.aborted) setPageLoading(false); });
    return () => controller.abort();
  }, [offset, queryAlerts, alerts, alertSummary]);

  async function handleEvaluateRules() {
    if (evaluationPending.current) return;
    evaluationPending.current = true;
    setIsEvaluating(true);
    setEvaluationMessage("");
    try {
      const result = await evaluateAlertRules();
      setEvaluationMessage(
        result.triggered
          ? `Created ${result.triggered} new alert${result.triggered === 1 ? "" : "s"}.`
          : "Rules evaluated. No new alerts."
      );
    } catch (error) {
      setEvaluationMessage(error instanceof Error ? error.message : "Unable to evaluate alert rules.");
    } finally {
      evaluationPending.current = false;
      setIsEvaluating(false);
    }
  }

  const openAlerts = useMemo(
    () => (offset > 0 ? page?.items ?? [] : alerts).filter((alert) => getAlertReviewState(alert) === "needs_review"),
    [offset, page, alerts]
  );
  const personWarnings = alertWarnings.filter((subject) => subject.subjectType === "employee" || subject.subjectType === "visitor");
  const confirmedWarnings = page?.summary?.confirmedWarnings ?? alertSummary?.confirmedWarnings ?? personWarnings.reduce((total, subject) => total + subject.count, 0);
  const openCount = page?.summary?.openCount ?? alertSummary?.openCount ?? openAlerts.length;
  return (
    <AdminPageFrame
      title="Alert Command Center"
      metric={`${openCount} open alerts · ${confirmedWarnings} confirmed warnings`}
      headerRight={
        <div className={styles.headerSkips}>
          <ScheduledIrregularitySkips assignments={alertRuleAssignments} />
        </div>
      }
      preTitle={
        <div className="alert-run-pretitle">
          <div className="alert-run-control">
            <button
              type="button"
              className="admin-button admin-button--secondary secondary-button compact-button"
              onClick={() => void handleEvaluateRules()}
              disabled={isEvaluating || isLoading}
            >
              {isEvaluating ? "Evaluating…" : "Run rules now"}
            </button>
            {evaluationMessage && <span role="status">{evaluationMessage}</span>}
          </div>
        </div>
      }
    >
      <section className={`alerts-command-stack ${styles.stack}`}>
        {error && <div className="alert-page-error admin-surface" role="status"><span>{error}</span><button type="button" disabled={isLoading} onClick={() => void refresh()}>{isLoading ? "Retrying…" : "Retry"}</button></div>}
        {pageError && <div className="alert-page-error admin-surface" role="status">{pageError}<button type="button" onClick={() => void refresh()}>Retry</button></div>}
        <div className="alerts-command-grid">
          <AlertActivity
            alerts={openAlerts}
            people={page?.people ?? people}
            onReview={reviewAlert}
            filter="needs_review"
            isLoading={isLoading || pageLoading}
            totalCount={openCount}
            pagination={openCount > pageSize ? <nav className={styles.pagination} aria-label="Open alert pages">
              <span>{offset + 1}–{Math.min(offset + pageSize, openCount)} of {openCount}</span>
              <button type="button" className="admin-button admin-button--secondary" disabled={isLoading || pageLoading || offset === 0} onClick={() => setOffset(current => Math.max(0, current - pageSize))}>Previous</button>
              <button type="button" className="admin-button admin-button--secondary" disabled={isLoading || pageLoading || offset + pageSize >= openCount} onClick={() => setOffset(current => current + pageSize)}>Next</button>
            </nav> : undefined}
          />
          <aside className="alert-support-stack" aria-label="People's warnings and automated rules">
            <EmployeeAlertManagement
              assignments={alertRuleAssignments}
              warnings={personWarnings}
              alerts={alerts}
              people={people}
              permissions={permissions}
              movements={movements}
              rules={alertRules}
              onReset={resetAlertWarnings}
              onSave={setAlertRuleAssignments}
              onReload={refresh}
              isLoading={isLoading}
            />
            <AutomatedRules rules={alertRules} />
          </aside>
        </div>
      </section>
    </AdminPageFrame>
  );
}
