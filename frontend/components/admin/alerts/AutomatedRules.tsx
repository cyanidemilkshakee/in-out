"use client";

import { useEffect, useMemo, useState } from "react";
import type { AlertRule } from "../../../../lib/types";

export function AutomatedRules({
  rules,
  onSave,
}: {
  rules: AlertRule[];
  onSave: (changes: Array<{ ruleId: string; enabled: boolean }>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(Object.fromEntries(rules.map((rule) => [rule.id, rule.enabled])));
  }, [rules]);

  const changes = useMemo(
    () => rules
      .filter((rule) => draft[rule.id] !== undefined && draft[rule.id] !== rule.enabled)
      .map((rule) => ({ ruleId: rule.id, enabled: draft[rule.id] })),
    [draft, rules]
  );

  async function saveRules() {
    setSaving(true);
    try {
      await onSave(changes);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="permission-rules alert-rules-section" aria-labelledby="alert-rules-title">
      <div className="permission-section-heading">
        <div>
          <h2 id="alert-rules-title">Automated rules</h2>
          <p>Conditions are evaluated after every scan and at end of day.</p>
        </div>
        <span>{rules.filter((rule) => (draft[rule.id] ?? rule.enabled)).length} enabled</span>
      </div>
      <div className="alert-rules-savebar">
        <span>{changes.length ? `${changes.length} unsaved change${changes.length === 1 ? "" : "s"}` : "Rules are saved"}</span>
        <button type="button" onClick={() => void saveRules()} disabled={!changes.length || saving}>
          {saving ? "Saving…" : "Save rules"}
        </button>
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
                  checked={draft[rule.id] ?? rule.enabled}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    setDraft((current) => ({ ...current, [rule.id]: enabled }));
                  }}
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
