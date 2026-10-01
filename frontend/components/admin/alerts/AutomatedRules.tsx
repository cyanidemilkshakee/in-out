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
  const [error, setError] = useState("");

  useEffect(() => {
    setDraft(current => Object.fromEntries(Object.entries(current).filter(([id, enabled]) =>
      rules.some(rule => rule.id === id && rule.enabled !== enabled))));
  }, [rules]);

  const changes = useMemo(
    () => rules
      .filter((rule) => draft[rule.id] !== undefined && draft[rule.id] !== rule.enabled)
      .map((rule) => ({ ruleId: rule.id, enabled: draft[rule.id] })),
    [draft, rules]
  );

  async function saveRules() {
    setSaving(true);
    setError("");
    try {
      await onSave(changes);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save alert rules.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="permission-rules alert-rules-section" aria-labelledby="alert-rules-title">
      <div className="permission-section-heading">
        <div>
          <h2 id="alert-rules-title">Automated rules</h2>
          <p>Attendance rules run every five minutes; the no-entry rule starts at 6:00 PM IST.</p>
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
        {error && <p role="alert">{error}</p>}
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
                  disabled={saving}
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
