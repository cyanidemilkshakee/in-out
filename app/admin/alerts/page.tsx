"use client";

import { useMemo, useRef, useState } from "react";
import { AdminPageFrame } from "../../../frontend/components/admin/tables/AdminPageFrame";
import { AlertActivity } from "../../../frontend/components/admin/alerts/AlertActivity";
import { AutomatedRules } from "../../../frontend/components/admin/alerts/AutomatedRules";
import { EmployeeAlertManagement } from "../../../frontend/components/admin/alerts/EmployeeAlertManagement";
import { ScheduledIrregularitySkips } from "../../../frontend/components/admin/alerts/ScheduledIrregularitySkips";
import { getAlertReviewState } from "../../../frontend/components/admin/alerts/alertPresentation";
import { useDataActions, useDataState } from "../../../frontend/context/DataContext";
import styles from "./AlertsPage.module.css";

export default function AlertsPage() {
  const { alerts, alertRules, alertWarnings, alertRuleAssignments, people, isLoading, error } = useDataState();
  const { reviewAlert, resetAlertWarnings, setAlertRuleAssignments, evaluateAlertRules, refresh } = useDataActions();
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [evaluationMessage, setEvaluationMessage] = useState("");
  const evaluationPending = useRef(false);

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
    () => alerts.filter((alert) => getAlertReviewState(alert) === "needs_review"),
    [alerts]
  );
  const employeeWarnings = alertWarnings.filter((subject) => subject.subjectType === "employee");
  const confirmedWarnings = employeeWarnings.reduce((total, subject) => total + subject.count, 0);
  return (
    <AdminPageFrame
      title="Alert Command Center"
      metric={`${openAlerts.length} open alerts · ${confirmedWarnings} confirmed warnings`}
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
        <div className="alerts-command-grid">
          <AlertActivity
            alerts={openAlerts}
            people={people}
            onReview={reviewAlert}
            filter="needs_review"
            isLoading={isLoading}
          />
          <aside className="alert-support-stack" aria-label="Employee warnings and automated rules">
            <EmployeeAlertManagement
              assignments={alertRuleAssignments}
              warnings={employeeWarnings}
              alerts={alerts}
              people={people}
              rules={alertRules}
              onReset={resetAlertWarnings}
              onSave={async (subjectId, ruleIds, irregularitySkipDates, revision) => { await setAlertRuleAssignments(subjectId, ruleIds, irregularitySkipDates, revision); }}
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
