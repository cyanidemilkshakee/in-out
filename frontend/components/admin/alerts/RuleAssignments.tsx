"use client";

import { useRef, useState, type ReactNode } from "react";
import { Check, LoaderCircle, Plus, X } from "lucide-react";
import type { AlertRule, AlertRuleAssignment } from "../../../../lib/types";
import { formatIrregularitySkipDate, irregularitySkipDateRange } from "../../../../lib/irregularitySkipDates";
import styles from "./EmployeeAlertManagement.module.css";

type AssignmentDraft = { ruleIds: string[]; irregularitySkipDates: string[]; revision: number };

export function RuleAssignments({ assignments, rules, selectedEmployeeId, onSave, onReload, isLoading = false, children }: {
  assignments: AlertRuleAssignment[];
  rules: AlertRule[];
  selectedEmployeeId?: string;
  onSave: (subjectId: string, ruleIds: string[], irregularitySkipDates: string[], expectedRevision: number) => Promise<void>;
  onReload: () => Promise<void>;
  isLoading?: boolean;
  children?: ReactNode;
}) {
  const [drafts, setDrafts] = useState<Record<string, AssignmentDraft>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dateDraft, setDateDraft] = useState({ subjectId: "", value: "" });
  const pending = useRef(false);
  const employeeAssignments = assignments.filter((subject) => subject.subjectType === "employee");
  const selected = employeeAssignments.find((subject) => subject.subjectId === selectedEmployeeId);
  const eligibleRules = rules.filter((rule) => (rule.eligibleSubjectTypes ?? ["employee"]).includes("employee"));
  const draft = selected ? drafts[selected.subjectId] : undefined;
  const newSkipDate = dateDraft.subjectId === selectedEmployeeId ? dateDraft.value : "";
  const checkedIds = draft?.ruleIds ?? selected?.ruleIds ?? [];
  const skipDates = draft?.irregularitySkipDates ?? selected?.irregularitySkipDates ?? [];
  const savedIds = selected?.ruleIds ?? [];
  const savedSkipDates = selected?.irregularitySkipDates ?? [];
  const rulesDirty = Boolean(selected && draft && (
    checkedIds.length !== savedIds.length || checkedIds.some((id) => !savedIds.includes(id))
  ));
  const skipDatesDirty = Boolean(selected && draft && (
    skipDates.length !== savedSkipDates.length || skipDates.some((date) => !savedSkipDates.includes(date))
  ));
  const dirty = rulesDirty || skipDatesDirty;
  const dateRange = irregularitySkipDateRange();

  function updateDraft(update: (current: AssignmentDraft) => AssignmentDraft) {
    if (!selected) return;
    setDrafts((current) => {
      const previous = current[selected.subjectId] ?? {
        ruleIds: selected.ruleIds,
        irregularitySkipDates: selected.irregularitySkipDates ?? [],
        revision: selected.revision,
      };
      return { ...current, [selected.subjectId]: update(previous) };
    });
  }

  async function save() {
    if (!selected || !dirty || pending.current) return;
    const subjectId = selected.subjectId;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await onSave(subjectId, checkedIds.filter((id) => eligibleRules.some((rule) => rule.id === id)), skipDates,
        draft?.revision ?? selected.revision);
      setDrafts((current) => { const next = { ...current }; delete next[subjectId]; return next; });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to save rule assignments."); }
    finally { pending.current = false; setBusy(false); }
  }

  async function reload() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try { await onReload(); setDrafts({}); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to reload rule assignments."); }
    finally { pending.current = false; setBusy(false); }
  }

  return <section className={styles.rules} aria-label="Rule assignments">
    {selected ? <>
        <div className={styles.sectionHeading}>
          <h3>Applied rules</h3>
          {eligibleRules.length > 0 && <button type="button" className={`${styles.button} ${styles.saveButton}`} aria-label={busy ? "Saving rule changes" : rulesDirty ? "Save rule changes" : "Rules saved"} disabled={busy || isLoading || !rulesDirty} onClick={() => void save()}>
            {busy ? <LoaderCircle size={17} className={styles.loadingIcon} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}
            {busy ? "Saving…" : rulesDirty ? "Save rules" : "Rules saved"}
          </button>}
        </div>
        <div className={styles.ruleList}>{eligibleRules.map((rule) => <label key={rule.id} className={styles.rule} data-checked={checkedIds.includes(rule.id)} data-disabled={busy || isLoading}><input type="checkbox" disabled={busy || isLoading} checked={checkedIds.includes(rule.id)} onChange={(event) => {
          const enabled = event.target.checked;
          updateDraft((previous) => ({ ...previous, ruleIds: enabled ? [...new Set([...previous.ruleIds, rule.id])] : previous.ruleIds.filter((id) => id !== rule.id) }));
        }} /><span><strong>{rule.name}</strong>{!rule.enabled && <small>Disabled globally</small>}</span></label>)}</div>
        {!eligibleRules.length && <p className={styles.empty}>No employee rules are available.</p>}
        <div className={styles.employeeControlsGrid}>
          <div className={styles.skipDates}>
            <div>
              <h4>Skip irregularity on</h4>
              <p>Use for leave or another planned absence. Other alerts still apply; dates can be scheduled up to six months ahead.</p>
            </div>
            <div className={styles.skipDateControls}>
              <label className={styles.dateField}>
                <span className={styles.visuallyHidden}>Date to skip irregularity</span>
                <input type="date" min={dateRange.today} max={dateRange.max} value={newSkipDate} disabled={busy || isLoading} onChange={(event) => setDateDraft({ subjectId: selected.subjectId, value: event.target.value })} />
              </label>
              <button type="button" className={styles.button} disabled={busy || isLoading || !newSkipDate || skipDates.includes(newSkipDate)} onClick={() => {
                if (!newSkipDate || skipDates.includes(newSkipDate)) return;
                updateDraft((previous) => ({ ...previous, irregularitySkipDates: [...previous.irregularitySkipDates, newSkipDate].sort() }));
                setDateDraft({ subjectId: selected.subjectId, value: "" });
              }}><Plus size={16} aria-hidden="true" /> Add date</button>
            </div>
            {skipDates.length > 0 && <ul className={styles.skipDateList} aria-label="Irregularity skip dates">
              {skipDates.map((date) => <li key={date}>{formatIrregularitySkipDate(date)}<button type="button" disabled={busy || isLoading} aria-label={`Remove ${formatIrregularitySkipDate(date)} irregularity skip date`} onClick={() => updateDraft((previous) => ({
                ...previous,
                irregularitySkipDates: previous.irregularitySkipDates.filter((value) => value !== date),
              }))}><X size={15} aria-hidden="true" /></button></li>)}
            </ul>}
            <div className={styles.skipDateFooter}>
              <button type="button" className={`${styles.button} ${styles.saveButton}`} aria-label={busy ? "Saving leave dates" : skipDatesDirty ? "Save leave dates" : "Leave dates saved"} disabled={busy || isLoading || !skipDatesDirty} onClick={() => void save()}>
                {busy ? <LoaderCircle size={17} className={styles.loadingIcon} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}
                {busy ? "Saving…" : skipDatesDirty ? "Save dates" : "Dates saved"}
              </button>
            </div>
          </div>
          {children}
        </div>
        {error && <div className={styles.errorPanel}><p className={styles.error} role="status">{error}</p><button className={styles.button} type="button" disabled={busy} onClick={() => void reload()}>Reload and discard changes</button></div>}
    </> : <div className={styles.employeeControlsGrid}>
      <p className={styles.empty}>{isLoading ? "Loading rule assignments…" : selectedEmployeeId ? "No rule assignment is available for this employee." : "Select an employee above to view assigned rules."}</p>
      {children}
    </div>}
  </section>;
}
