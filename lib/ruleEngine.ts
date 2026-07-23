import type {
  Alert,
  AlertRule,
  HardwareAsset,
  MovementEvent,
  Person,
  WorkdayStatus,
} from "./types";

type ScheduledRuleInput = {
  rules: AlertRule[];
  movements: MovementEvent[];
  workdays: WorkdayStatus[];
  existingAlerts: Alert[];
};

function nextAlertId(existingAlerts: Alert[], offset = 1) {
  const highest = existingAlerts.reduce((max, alert) => {
    const value = Number(alert.id.match(/(\d+)$/)?.[1] ?? 0);
    return Math.max(max, value);
  }, 0);
  return `AL-2026-${String(highest + offset).padStart(4, "0")}`;
}

function findEnabledRule(rules: AlertRule[], conditionKey: AlertRule["conditionKey"]) {
  return rules.find((rule) => rule.conditionKey === conditionKey && rule.enabled);
}

export function evaluateScheduledRules({
  rules,
  movements,
  workdays,
  existingAlerts,
}: ScheduledRuleInput) {
  const generated: Alert[] = [];
  const exitRule = findEnabledRule(rules, "exit_balance");

  if (exitRule) {
    const totalsByDate = new Map<string, { entries: number; exits: number }>();
    for (const event of movements) {
      if (event.result !== "approved") continue;
      const totals = totalsByDate.get(event.date) ?? { entries: 0, exits: 0 };
      if (event.direction === "entry") totals.entries += 1;
      if (event.direction === "exit") totals.exits += 1;
      totalsByDate.set(event.date, totals);
    }

    for (const [date, totals] of totalsByDate) {
      const alreadyRaised = existingAlerts.some(
        (alert) => alert.ruleId === exitRule.id && alert.date === date
      );
      if (totals.exits <= totals.entries || alreadyRaised) continue;
      generated.push({
        id: nextAlertId([...existingAlerts, ...generated]),
        severity: exitRule.severity,
        status: "open",
        title: "Exit count exceeds entry count",
        reason: `${totals.exits} exits were recorded against ${totals.entries} entries.`,
        subjectName: "Facility occupancy",
        barcode: "SYSTEM",
        checkpoint: "All checkpoints",
        date,
        time: "6:05:00 PM",
        category: exitRule.category,
        ruleId: exitRule.id,
        explanation: "Daily approved exit count is greater than the approved entry count.",
      });
    }
  }

  const breakRule = findEnabledRule(rules, "no_break");
  if (breakRule) {
    for (const workday of workdays) {
      const alreadyRaised = existingAlerts.some(
        (alert) =>
          alert.ruleId === breakRule.id &&
          alert.subjectName === workday.employeeName &&
          alert.date === workday.date
      );
      if (
        !workday.shiftEnded ||
        workday.breakMinutes > 0 ||
        workday.minutesInside < 360 ||
        alreadyRaised
      ) {
        continue;
      }
      generated.push({
        id: nextAlertId([...existingAlerts, ...generated]),
        severity: breakRule.severity,
        status: "open",
        title: "No break recorded by end of day",
        reason: `${workday.employeeName} completed ${Math.round(
          workday.minutesInside / 60
        )} hours without a recorded break.`,
        subjectName: workday.employeeName,
        barcode: workday.employeeId,
        checkpoint: "Attendance policy",
        date: workday.date,
        time: "6:00:00 PM",
        category: breakRule.category,
        ruleId: breakRule.id,
        explanation: "Shift ended with zero qualifying break minutes.",
      });
    }
  }

  return generated;
}

export function createScanAlert({
  event,
  subject,
  carriedHardware,
  rules,
  existingAlerts,
}: {
  event: MovementEvent;
  subject?: Person | HardwareAsset;
  carriedHardware: HardwareAsset[];
  rules: AlertRule[];
  existingAlerts: Alert[];
}) {
  if (event.result !== "denied") return undefined;

  let rule: AlertRule | undefined;
  let category: NonNullable<Alert["category"]> = "access_violation";
  let title = "Access decision denied";

  if (event.reason?.startsWith("Hardware assigned to")) {
    rule = findEnabledRule(rules, "unauthorized_hardware_carrier");
    category = "hardware_custody";
    title = "Unauthorized hardware carrier";
  } else if (
    subject &&
    "type" in subject &&
    subject.type === "employee" &&
    subject.status === "restricted"
  ) {
    rule = findEnabledRule(rules, "restricted_employee_entry");
    category = "access_violation";
    title = "Restricted employee entry attempt";
  }

  if (!rule && event.reason !== "Temporary visitor approval pending") return undefined;
  if (rule && !rule.enabled) return undefined;
  if (
    existingAlerts.some(
      (alert) => alert.sourceEventId === event.id || (alert.ruleId === rule?.id && alert.status === "open")
    )
  ) {
    return undefined;
  }

  const hardwareNames = carriedHardware.map((asset) => asset.name).join(", ");
  return {
    id: nextAlertId(existingAlerts),
    severity: rule?.severity ?? "medium",
    status: "open" as const,
    title,
    reason: event.reason ?? "Policy denied the movement.",
    subjectName: event.subjectName,
    barcode: event.barcode,
    checkpoint: event.checkpoint,
    date: event.date,
    time: event.time,
    category,
    ruleId: rule?.id,
    sourceEventId: event.id,
    explanation: hardwareNames
      ? `Carrier and assigned custodian do not match for ${hardwareNames}.`
      : "The access decision matched an enabled security rule.",
  } satisfies Alert;
}
