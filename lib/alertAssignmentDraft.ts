import type { AlertRuleAssignment } from "./types";

export type AssignmentDraft = {
  ruleIds: string[];
  irregularitySkipDates: string[];
  revision: number;
};

export type AssignmentSection = "rules" | "dates";

function sameValues(left: string[], right: string[]) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

export function assignmentSaveInput(
  saved: AlertRuleAssignment,
  draft: AssignmentDraft,
  section: AssignmentSection,
  eligibleRuleIds: string[],
): AssignmentDraft {
  return {
    ruleIds: section === "rules"
      ? draft.ruleIds.filter((id) => eligibleRuleIds.includes(id))
      : saved.ruleIds,
    irregularitySkipDates: section === "dates"
      ? draft.irregularitySkipDates
      : saved.irregularitySkipDates ?? [],
    revision: draft.revision,
  };
}

export function remainingAssignmentDraft(
  draft: AssignmentDraft,
  saved: AlertRuleAssignment,
  section: AssignmentSection,
): AssignmentDraft | undefined {
  const next = {
    ruleIds: section === "rules" ? saved.ruleIds : draft.ruleIds,
    irregularitySkipDates: section === "dates"
      ? saved.irregularitySkipDates ?? []
      : draft.irregularitySkipDates,
    revision: saved.revision,
  };
  return sameValues(next.ruleIds, saved.ruleIds)
    && sameValues(next.irregularitySkipDates, saved.irregularitySkipDates ?? [])
    ? undefined : next;
}
