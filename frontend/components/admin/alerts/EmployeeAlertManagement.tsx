"use client";

import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { Alert, AlertPage, AlertRule, AlertRuleAssignment, AlertWarningSummary, MovementEvent, Person } from "../../../../lib/types";
import { useDataActions } from "../../../context/DataContext";
import { AlertSubjectPicker, type AlertSubjectOption } from "./AlertSubjectPicker";
import { RuleAssignments } from "./RuleAssignments";
import { WarningSummary } from "./WarningSummary";
import styles from "./EmployeeAlertManagement.module.css";

const EmployeeProfileCard = lazy(() =>
  import("../EmployeeProfileCard").then((module) => ({ default: module.EmployeeProfileCard }))
);

export function EmployeeAlertManagement({ assignments, warnings, alerts, rules, people, movements, onReset, onSave, onReload, isLoading = false }: {
  assignments: AlertRuleAssignment[];
  warnings: AlertWarningSummary[];
  alerts: Alert[];
  rules: AlertRule[];
  people: Person[];
  movements: MovementEvent[];
  onReset: (subjectId: string, reason: string) => Promise<void>;
  onSave: (subjectId: string, ruleIds: string[], irregularitySkipDates: string[], expectedRevision: number) => Promise<AlertRuleAssignment>;
  onReload: () => Promise<void>;
  isLoading?: boolean;
}) {
  const [selectedSubjectId, setSelectedSubjectId] = useState("");
  const [selectedOption, setSelectedOption] = useState<AlertSubjectOption | null>(null);
  const [profilePerson, setProfilePerson] = useState<Person | null>(null);
  const [search, setSearch] = useState("");
  const [directory, setDirectory] = useState<{ people: Person[]; total: number } | null>(null);
  const [detail, setDetail] = useState<AlertPage | null>(null);
  const [searching, setSearching] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [readError, setReadError] = useState("");
  const { queryRegistrySubjects, queryAlerts } = useDataActions();
  useEffect(() => {
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      void queryRegistrySubjects({ kind: "people", search: search.trim(), limit: 25, offset: 0 }, controller.signal)
        .then((page) => {
          if (controller.signal.aborted) return;
          setDirectory({ people: page.items.filter((person): person is Person => "type" in person), total: page.total });
          setReadError("");
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setReadError(cause instanceof Error ? cause.message : "Unable to search people.");
        })
        .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [queryRegistrySubjects, search]);

  useEffect(() => {
    setDetail(null);
    if (!selectedSubjectId) { setDetailLoading(false); return; }
    const controller = new AbortController();
    setDetailLoading(true);
    void queryAlerts({ view: "subject", subjectId: selectedSubjectId, status: "warned", limit: 3, offset: 0 }, controller.signal)
      .then((page) => { if (!controller.signal.aborted) { setDetail(page); setReadError(""); } })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setReadError(cause instanceof Error ? cause.message : "Unable to load warnings."); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [selectedSubjectId, queryAlerts, alerts, assignments]);

  const subjects = useMemo(() => {
    const byId = new Map<string, AlertSubjectOption>();
    (directory?.people ?? people).filter((person) => person.type === "employee" || person.type === "visitor").forEach((person) => {
      byId.set(person.id, {
        subjectId: person.id,
        subjectName: person.name,
        barcode: person.barcode,
        subjectType: person.type,
        status: person.type === "employee" ? person.status : undefined,
      });
    });
    if (selectedOption && !byId.has(selectedOption.subjectId)) byId.set(selectedOption.subjectId, selectedOption);
    return [...byId.values()].sort((left, right) => left.subjectName.localeCompare(right.subjectName));
  }, [directory, people, selectedOption]);
  const selectedSubject = subjects.find((subject) => subject.subjectId === selectedSubjectId);
  const selectedEmployee = selectedSubject?.subjectType === "employee" ? selectedSubject : undefined;
  const selectedPerson = (detail?.people ?? people).find((person) => person.id === selectedSubjectId && person.type === "employee");
  const selectedWarnings = detail?.warnings ?? warnings.filter((warning) => warning.subjectId === selectedSubjectId);
  const selectedAssignments = detail?.assignments ?? [];
  const selectedAlerts = detail?.currentWarnings ?? detail?.items ?? [];
  const settingsLoading = isLoading || detailLoading;

  return <section className={styles.panel} aria-labelledby="alert-subject-rules-title">
    <header className={styles.header}>
      <h2 id="alert-subject-rules-title">Warnings &amp; rules</h2>
    </header>
    <div className={styles.selector}>
      <AlertSubjectPicker subjects={subjects} selectedId={selectedSubjectId} search={search} onSearch={setSearch} total={directory?.total} isSearching={searching} onSelect={(id) => { setSelectedSubjectId(id); setSelectedOption(subjects.find((subject) => subject.subjectId === id) ?? null); setProfilePerson(null); }} disabled={isLoading} />
      {readError && <p className={styles.error} role="status">{readError}</p>}
    </div>
    {selectedSubject ? <div className={`${styles.sections} scrollable-content`}>
      {selectedEmployee ? <RuleAssignments assignments={selectedAssignments} rules={rules} selectedEmployeeId={selectedSubjectId} onSave={onSave} onReload={onReload} onViewProfile={selectedPerson ? () => setProfilePerson(selectedPerson) : undefined} isLoading={settingsLoading}>
        <WarningSummary alerts={selectedAlerts} warnings={selectedWarnings} selectedSubject={selectedSubject} onReset={onReset} isLoading={settingsLoading} />
      </RuleAssignments> : <>
        <p className={styles.empty}>Visitor alerts are evaluated using facility-wide visitor rules.</p>
        <WarningSummary alerts={selectedAlerts} warnings={selectedWarnings} selectedSubject={selectedSubject} onReset={onReset} isLoading={settingsLoading} />
      </>}
    </div> : <div className={`${styles.sections} scrollable-content`}>
      {isLoading ? <p className={styles.empty}>Loading alert data…</p> : !subjects.length ? <p className={styles.empty}>No people are available.</p> : null}
    </div>}
    {profilePerson ? <Suspense fallback={null}>
      <EmployeeProfileCard
        person={profilePerson}
        sessions={[]}
        alerts={alerts}
        movements={movements}
        onClose={() => setProfilePerson(null)}
      />
    </Suspense> : null}
  </section>;
}
