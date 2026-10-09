"use client";

import type { AlertRule } from "../../../../lib/types";

export function AutomatedRules({ rules }: { rules: AlertRule[] }) {
  const employeeRules = rules.filter((rule) => (rule.eligibleSubjectTypes ?? ["employee"]).includes("employee"));
  return (
    <section className="permission-rules alert-rules-section admin-surface" aria-labelledby="alert-rules-title">
      <div className="permission-section-heading">
        <div>
          <h2 id="alert-rules-title">Automated rules</h2>
        </div>
        <span>{employeeRules.filter((rule) => rule.enabled).length} enabled</span>
      </div>
      <div className="alert-rule-list">
        {employeeRules.map((rule) => (
          <article className="alert-rule-card admin-surface" key={rule.id}>
            <header>
              <span>
                <strong>{rule.name}</strong>
                <small>{rule.description}</small>
              </span>
              <span className="alert-rule-status admin-surface" data-enabled={rule.enabled}>{rule.enabled ? "Enabled" : "Disabled"}</span>
            </header>
            <footer>
              <span className="alert-rule-trigger">{rule.recentTriggers} Triggers / last 7 days</span>
            </footer>
            <small className="alert-rule-eligibility">Eligible: Employees</small>
          </article>
        ))}
        {!employeeRules.length && <p className="alert-section-empty">No employee rules are available.</p>}
      </div>
    </section>
  );
}
