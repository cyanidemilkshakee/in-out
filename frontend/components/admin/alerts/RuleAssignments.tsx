"use client";

import { useRef, useState, type ReactNode } from "react";
import { Check, Eye, LoaderCircle, Plus, X } from "lucide-react";
import type { AlertRule, AlertRuleAssignment } from "../../../../lib/types";
import { formatIrregularitySkipDate, irregularitySkipDateRange, isIrregularitySkipDate } from "../../../../lib/irregularitySkipDates";
import { assignmentSaveInput, remainingAssignmentDraft, type AssignmentDraft, type AssignmentSection } from "../../../../lib/alertAssignmentDraft";
import styles from "./EmployeeAlertManagement.module.css";

export function RuleAssignments({ assignments, rules, selectedEmployeeId, onSave, onReload, onViewProfile, isLoading = false, profileLayout = false, profileSchedule, children }: {
  assignments: AlertRuleAssignment[];
  rules: AlertRule[];
  selectedEmployeeId?: string;
  onSave: (subjectId: string, ruleIds: string[], irregularitySkipDates: string[], expectedRevision: number) => Promise<AlertRuleAssignment>;
  onReload: () => Promise<void>;
  onViewProfile?: () => void;
  isLoading?: boolean;
  profileLayout?: boolean;
  profileSchedule?: ReactNode;
  children?: ReactNode;
}) {
  const [drafts, setDrafts] = useState<Record<string, AssignmentDraft>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dateDraft, setDateDraft] = useState({ subjectId: "", value: "" });
  const pending = useRef(false);
  const skipDateInput = useRef<HTMLInputElement>(null);
  const employeeAssignments = assignments.filter((subject) => subject.subjectType === "employee");
  const selected = employeeAssignments.find((subject) => subject.subjectId === selectedEmployeeId);
  const eligibleRules = rules.filter((rule) =>
    (rule.conditionKey === "no_break" || rule.conditionKey === "irregularity")
    && (rule.eligibleSubjectTypes ?? ["employee"]).includes("employee"));
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

  async function save(section: AssignmentSection) {
    if (!selected || !draft || !(section === "rules" ? rulesDirty : skipDatesDirty) || pending.current) return;
    const subjectId = selected.subjectId;
    const input = assignmentSaveInput(selected, draft, section, eligibleRules.map((rule) => rule.id));
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const saved = await onSave(subjectId, input.ruleIds, input.irregularitySkipDates, input.revision);
      setDrafts((current) => {
        const next = { ...current };
        const remaining = remainingAssignmentDraft(current[subjectId] ?? draft, saved, section);
        if (remaining) next[subjectId] = remaining;
        else delete next[subjectId];
        return next;
      });
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

  const rulesSaveButton = eligibleRules.length > 0 ? <button type="button" className={`${styles.button} ${styles.saveButton}`} aria-label={busy ? "Saving rule changes" : rulesDirty ? "Save rule changes" : "Rules saved"} disabled={busy || isLoading || !rulesDirty} onClick={() => void save("rules")}>
      {busy ? <LoaderCircle size={17} className={styles.loadingIcon} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}
      {busy ? "Saving…" : rulesDirty ? "Save rules" : "Rules saved"}
    </button> : null;
  const rulesHeading = selected ? <div className={styles.sectionHeading}>
    <h3>Applied rules</h3>
    {rulesSaveButton}
  </div> : null;
  const rulesList = selected ? <div className={`${styles.ruleList}${profileLayout ? " employee-profile-rule-list" : ""}`}>{eligibleRules.map((rule) => <label key={rule.id} className={`${styles.rule}${profileLayout ? " employee-profile-rule" : ""}`} data-checked={checkedIds.includes(rule.id)} data-disabled={busy || isLoading}><input type="checkbox" disabled={busy || isLoading} checked={checkedIds.includes(rule.id)} onChange={(event) => {
    const enabled = event.target.checked;
    updateDraft((previous) => ({ ...previous, ruleIds: enabled ? [...new Set([...previous.ruleIds, rule.id])] : previous.ruleIds.filter((id) => id !== rule.id) }));
  }} /><span><strong>{rule.name}</strong>{!rule.enabled && <small>Disabled globally</small>}</span></label>)}</div> : null;
  const skipDatePanel = selected ? <div className={styles.skipDates}>
    <div>
      <h4>Skip irregularity on</h4>
      {!profileLayout && <p>Use for leave or another planned absence. Other alerts still apply; dates can be scheduled up to six months ahead.</p>}
    </div>
    <div className={styles.skipDateControls}>
      <label className={styles.dateField}>
        <span className={styles.visuallyHidden}>Date to skip irregularity</span>
        <input ref={skipDateInput} type="date" min={dateRange.today} max={dateRange.max} value={newSkipDate} disabled={busy || isLoading} onChange={(event) => setDateDraft({ subjectId: selected.subjectId, value: event.target.value })} />
      </label>
      <button type="button" className={styles.button} disabled={busy || isLoading || !isIrregularitySkipDate(newSkipDate) || skipDates.includes(newSkipDate)} onClick={() => {
        if (!skipDateInput.current?.reportValidity() || !isIrregularitySkipDate(newSkipDate) || skipDates.includes(newSkipDate)) return;
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
      {onViewProfile ? <button type="button" className={`${styles.button} ${styles.profileButton}`} disabled={busy || isLoading} onClick={onViewProfile}>
        <Eye size={16} aria-hidden="true" /> View employee profile
      </button> : <span aria-hidden="true" />}
      <button type="button" className={`${styles.button} ${styles.saveButton}`} aria-label={busy ? "Saving leave dates" : skipDatesDirty ? "Save leave dates" : "Leave dates saved"} disabled={busy || isLoading || !skipDatesDirty} onClick={() => void save("dates")}>
        {busy ? <LoaderCircle size={17} className={styles.loadingIcon} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}
        {busy ? "Saving…" : skipDatesDirty ? "Save dates" : "Dates saved"}
      </button>
    </div>
  </div> : null;
  const assignmentError = error ? <div className={styles.errorPanel}><p className={styles.error} role="status">{error}</p><button className={styles.button} type="button" disabled={busy} onClick={() => void reload()}>Reload and discard changes</button></div> : null;

  if (profileLayout) return <>
    <section className={`${styles.rules} ${styles.profileRules} employee-profile-rules-card`} aria-label="Applied rules">
      <div className={styles.sectionHeading}><h3>Applied rules</h3>{selected ? rulesSaveButton : null}</div>
      {selected ? <>{rulesList}{!eligibleRules.length && <p className={styles.empty}>No employee rules are available.</p>}{assignmentError}</> : <p className={styles.empty}>{isLoading ? "Loading rule assignments…" : "No rule assignment is available for this employee."}</p>}
    </section>
    {children}
    <section className={`${styles.profileSkipCard} employee-profile-leave-card`} aria-label="Irregularity skips">
      {selected ? skipDatePanel : <p className={styles.empty}>{isLoading ? "Loading irregularity skips…" : "No rule assignment is available for this employee."}</p>}
    </section>
    <section className={`${styles.profileScheduleColumn} employee-profile-schedule-section`} aria-label="Scheduled irregularity skips">
      {profileSchedule}
    </section>
  </>;

  return <section className={styles.rules} aria-label="Rule assignments">
    {selected ? <>
      {rulesHeading}
      {rulesList}
      {!eligibleRules.length && <p className={styles.empty}>No employee rules are available.</p>}
      <div className={`${styles.employeeControlsGrid}${children ? "" : ` ${styles.employeeControlsSingle}`}`}>
        {skipDatePanel}
        {children}
      </div>
      {assignmentError}
    </> : <div className={`${styles.employeeControlsGrid}${children ? "" : ` ${styles.employeeControlsSingle}`}`}>
      <p className={styles.empty}>{isLoading ? "Loading rule assignments…" : selectedEmployeeId ? "No rule assignment is available for this employee." : "Select an employee above to view assigned rules."}</p>
      {children}
    </div>}
  </section>;
}
