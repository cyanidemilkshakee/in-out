import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ProfilePage from "../app/admin/profile/page";
import { AutomatedRules } from "../frontend/components/admin/alerts/AutomatedRules";
import { PersonStatusLabel } from "../frontend/components/admin/PersonStatusLabel";
import { MovementTable } from "../frontend/components/admin/tables/MovementTable";
import { normalizeDashboardMovement } from "../lib/normalizeDashboard";
import { assignmentSaveInput, remainingAssignmentDraft } from "../lib/alertAssignmentDraft";
import type { AlertRule, AlertRuleAssignment, Person } from "../lib/types";
import { updateAdminProfile } from "../services/profileService";
import { isIrregularitySkipDate } from "../lib/irregularitySkipDates";

test("hardware history renders every carried asset with its carrier and original scan link", () => {
  const sourceEventId = "315d7602-1d79-439f-9e51-a92998a15e58";
  const events = ["Laptop", "Monitor"].map((subjectName, index) => normalizeDashboardMovement({
    id: `asset-row-${index}`, subjectId: `asset-${index}`, subjectType: "hardware", subjectName,
    barcode: `HW-${index + 1}`, sourceEventId, carrierId: "employee", carrierName: "Alice <Gate & Co>",
    result: "approved", direction: "exit", hardwareIds: [],
  }));
  events.push(normalizeDashboardMovement({ id: "direct-scan", subjectType: "hardware", subjectName: "Direct asset",
    barcode: "HW-3", result: "approved", direction: "entry" }));
  const html = renderToStaticMarkup(createElement(MovementTable, {
    events, people: [], sortKey: "name", sortDirection: "asc", density: "comfortable", onSort: () => {},
    visibleColumns: { name: true, barcode: true, date: false, time: false, createdAt: false, active: false,
      type: false, direction: false, checkpoint: false, result: false, scanType: false, eventId: false },
  }));
  assert.match(html, /Laptop/);
  assert.match(html, /Monitor/);
  assert.match(html, /Direct asset/);
  assert.equal((html.match(/Carried by Alice &lt;Gate &amp; Co&gt;/g) ?? []).length, 2);
  assert.equal((html.match(new RegExp(`href="/admin/logs\\?eventId=${sourceEventId}"`, "g")) ?? []).length, 2);
  assert.equal((html.match(/>Source scan<\/a>/g) ?? []).length, 2);
  assert.doesNotMatch(html, /<Gate/);
});

test("person labels retain visitor approval, restriction and expiry states", () => {
  const cases: Array<[Person["status"], string]> = [
    ["active", "Active"], ["inactive", "Inactive"], ["pre_approved", "Pre-approved"],
    ["pending_approval", "Pending approval"], ["restricted", "Restricted"], ["expired", "Expired"],
  ];
  for (const [status, label] of cases) {
    const html = renderToStaticMarkup(createElement(PersonStatusLabel, { status }));
    assert.match(html, new RegExp(`>${label}</span>`));
    if (status !== "inactive") assert.doesNotMatch(html, />Inactive</);
  }
  assert.equal(renderToStaticMarkup(createElement(PersonStatusLabel, {})), "");
});

test("Automated rules displays visitor and cross-building alerts with automatic coverage", () => {
  const rule = { category: "presence_anomaly", severity: "medium", enabled: true, scope: "", recentTriggers: 0 } as const;
  const rules: AlertRule[] = [
    { ...rule, id: "rule-cross-building-scan", name: "Cross-building scan", description: "Scan while inside another building.", conditionKey: "cross_building_scan", eligibleSubjectTypes: ["employee", "visitor"] },
    { ...rule, id: "rule-visitor-overstay", name: "Visitor overstay", description: "Inside for more than twelve hours.", conditionKey: "visitor_overstay", eligibleSubjectTypes: ["visitor"] },
    { ...rule, id: "rule-no-break", name: "No break recorded", description: "Employee workday.", conditionKey: "no_break", eligibleSubjectTypes: ["employee"] },
  ];
  const html = renderToStaticMarkup(createElement(AutomatedRules, { rules }));
  assert.match(html, /3 enabled/);
  assert.match(html, /Visitor overstay/);
  assert.match(html, /Eligible: All employees and visitors/);
  assert.match(html, /Eligible: All visitors/);
  assert.match(html, /Employees · Assigned per employee/);
});

test("Add date rejects typed invalid dates and dates outside the six-month calendar window", () => {
  const now = new Date("2026-08-31T06:00:00Z");
  assert.equal(isIrregularitySkipDate("2026-08-31", now), true);
  assert.equal(isIrregularitySkipDate("2027-02-28", now), true);
  for (const date of ["2026-08-30", "2027-03-01", "2026-09-31", "2126-09-01", ""]) {
    assert.equal(isIrregularitySkipDate(date, now), false);
  }
});

const assignment: AlertRuleAssignment = {
  subjectId: "employee", subjectName: "Employee", subjectType: "employee", barcode: "EMP-1",
  ruleIds: ["irregularity", "break"], irregularitySkipDates: [], revision: 3,
  source: "custom",
};

test("Save dates leaves an unsaved rule change uncommitted and keeps it for the next revision", () => {
  const draft = { ruleIds: ["break"], irregularitySkipDates: ["2026-10-12"], revision: 3 };
  const input = assignmentSaveInput(assignment, draft, "dates", assignment.ruleIds);
  assert.deepEqual(input.ruleIds, assignment.ruleIds);
  const saved = { ...assignment, irregularitySkipDates: input.irregularitySkipDates, revision: 4 };
  const remaining = remainingAssignmentDraft(draft, saved, "dates");
  assert.deepEqual(remaining, { ...draft, revision: 4 });
  assert.deepEqual(assignmentSaveInput(saved, remaining!, "rules", assignment.ruleIds), {
    ruleIds: ["break"], irregularitySkipDates: ["2026-10-12"], revision: 4,
  });
});

test("Save rules leaves draft leave dates uncommitted, then Save dates keeps the saved rules", () => {
  const draft = { ruleIds: ["break"], irregularitySkipDates: ["2026-10-12"], revision: 3 };
  const input = assignmentSaveInput(assignment, draft, "rules", assignment.ruleIds);
  assert.deepEqual(input.irregularitySkipDates, []);
  const saved = { ...assignment, ruleIds: input.ruleIds, revision: 4 };
  const remaining = remainingAssignmentDraft(draft, saved, "rules")!;
  const dates = assignmentSaveInput(saved, remaining, "dates", assignment.ruleIds);
  assert.deepEqual(dates.ruleIds, ["break"]);
  assert.equal(remainingAssignmentDraft(remaining, { ...saved, irregularitySkipDates: dates.irregularitySkipDates, revision: 5 }, "dates"), undefined);
});

test("Profile starts with saving and identity fields disabled without fallback identity values", () => {
  const html = renderToStaticMarkup(createElement(ProfilePage));
  assert.match(html, /Loading profile/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>[\s\S]*?Save preferences/);
  assert.match(html, /<input[^>]*autoComplete="name"[^>]*disabled=""/);
  assert.doesNotMatch(html, /admin@company\.com|ops-admin/);
  assert.match(html, /Approval notes are optional/);
});

test("Profile preferences save omits identity email and accepts an email-less server profile", async () => {
  const original = globalThis.fetch;
  let sent: Record<string, unknown> | undefined;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return Response.json({ data: { id: "admin", ...sent, email: "" } });
  };
  try {
    const result = await updateAdminProfile({ name: "Operator Admin", nickname: "ops", avatarDataUrl: "", settings: { requireReviewNote: true } });
    assert.equal(result.email, "");
    assert.equal(Object.hasOwn(sent!, "email"), false);
    assert.equal(sent!.name, "Operator Admin");
  } finally { globalThis.fetch = original; }
});
