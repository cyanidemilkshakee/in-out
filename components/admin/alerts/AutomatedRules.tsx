"use client";

import type { AlertRule } from "../../../lib/types";

export function AutomatedRules({
  rules,
  onToggle,
}: {
  rules: AlertRule[];
  onToggle: (ruleId: string, enabled: boolean) => void;
}) {
  return (
    <section className="permission-rules alert-rules-section" aria-labelledby="alert-rules-title">
      <div className="permission-section-heading">
        <div>
          <h2 id="alert-rules-title">Automated rules</h2>
          <p>Conditions are evaluated after every scan and at end of day.</p>
        </div>
        <span>{rules.filter((rule) => rule.enabled).length} enabled</span>
      </div>
      <div className="alert-rule-list">
        {rules.map((rule) => (
          <article className="alert-rule-card" key={rule.id}>
            <header>
              <span>
                <strong>{rule.name}</strong>
                <small>{rule.description}</small>
              </span>
              <label className="permission-switch">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={(event) => onToggle(rule.id, event.target.checked)}
                  aria-label={`Enable ${rule.name}`}
                />
                <span aria-hidden="true" />
              </label>
            </header>
            <footer>
              <span className="rule-severity" data-severity={rule.severity}>{rule.severity}</span>
              <span>{rule.scope}</span>
              <span className="alert-rule-trigger">
                <strong>{rule.recentTriggers}</strong>
                <small>Triggers / last 7 days</small>
              </span>
            </footer>
          </article>
        ))}
      </div>
    </section>
  );
}
