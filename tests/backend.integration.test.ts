import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  closeDatabaseForTests,
  resetDatabaseForTests,
  verifyPassword,
  hashPassword,
} from "../backend/database";
import {
  addMovementNote,
  createEmployee,
  createHardwareAsset,
  createTemporaryVisitor,
  decidePermissionRequest,
  getSnapshot,
  markNotificationRead,
  queryMovements,
  recordScan,
  resolveMovementConflicts,
  saveMovement,
  syncMovements,
  updateAccessPermission,
  updateAlert,
  updateAlertRule,
  updateHardwareAsset,
  updatePerson,
} from "../backend/dataRepository";
import {
  getCurrentAdminProfile,
  updateCurrentAdminProfile,
} from "../backend/profileRepository";
import { buildSeedData } from "../backend/seedData";
import { getPersonSessions } from "../lib/analyticsUtils";
import { parseDateInput } from "../lib/dateRanges";
import type { MovementEvent } from "../lib/types";

process.env.ALLOW_DATABASE_RESET = "true";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://inout:inout@127.0.0.1:5433/inout_test";

before(async () => {
  await resetDatabaseForTests();
});

after(async () => {
  await closeDatabaseForTests();
});

test("seeds coherent scoped snapshots from PostgreSQL", async () => {
  const all = await getSnapshot("all");
  assert.ok(all.people.length >= 10);
  assert.ok(all.hardwareAssets.length >= 5);
  assert.ok(all.movements.length > 100);
  assert.ok(all.checkpoints.length >= 4);
  assert.equal(all.scanAnalytics.totalScans, all.movements.length);
  assert.equal(
    all.scanAnalytics.totalDenied,
    all.scanAnalytics.totalRestricted +
      all.scanAnalytics.totalExpired +
      all.scanAnalytics.totalOtherDenied
  );

  const profileScope = await getSnapshot("profile");
  assert.equal(profileScope.people.length, 0);
  assert.equal(profileScope.movements.length, 0);
  assert.equal(profileScope.alerts.length, 0);
});

test("does not generate current-day movement records in the future", () => {
  const anchor = new Date("2026-07-28T05:30:00.000Z");
  const seed = buildSeedData(anchor);
  assert.ok(
    seed.snapshot.movements.every(
      (movement) =>
        Boolean(movement.createdAt) &&
        new Date(movement.createdAt as string).getTime() <= anchor.getTime()
    )
  );
});

test("records approved and denied scans as persistent movements", async () => {
  const before = await getSnapshot("all");
  const checkpoint = before.checkpoints.find((item) =>
    before.people.some(
      (person) =>
        person.status === "active" && person.allowedZones.includes(item.zone)
    )
  );
  assert.ok(checkpoint);
  const subject = before.people.find(
    (person) =>
      person.status === "active" && person.allowedZones.includes(checkpoint.zone)
  );
  assert.ok(subject);

  const approved = await recordScan({
    barcode: subject.barcode,
    checkpointId: checkpoint.id,
    selectedHardwareIds: [],
    online: true,
    scanType: "auto",
  });
  assert.equal(approved.decision.event.result, "approved");
  assert.ok(approved.updatedPeople.length <= 1);
  assert.ok(approved.updatedHardwareAssets.length <= 1);
  assert.equal("people" in approved, false);

  const denied = await recordScan({
    barcode: "NOT-A-REAL-BARCODE",
    checkpointId: checkpoint.id,
    selectedHardwareIds: [],
    online: true,
    scanType: "manual",
  });
  assert.equal(denied.decision.event.result, "denied");
  assert.equal(denied.decision.event.denialCode, "barcode_not_registered");

  const afterScans = await getSnapshot("all");
  assert.equal(afterScans.movements.length, before.movements.length + 2);
  assert.ok(
    afterScans.movements.some(
      (movement) => movement.id === denied.decision.event.id
    )
  );
});

test("filters and paginates movement queries in PostgreSQL", async () => {
  const firstPage = await queryMovements({
    page: 1,
    pageSize: 10,
    result: "approved",
    subjectGroup: "people",
    sortKey: "createdAt",
    sortDirection: "desc",
  });
  const secondPage = await queryMovements({
    page: 2,
    pageSize: 10,
    result: "approved",
    subjectGroup: "people",
    sortKey: "createdAt",
    sortDirection: "desc",
  });

  assert.equal(firstPage.items.length, 10);
  assert.ok(firstPage.total >= firstPage.items.length);
  assert.ok(
    firstPage.items.every(
      (movement) =>
        movement.result === "approved" &&
        movement.subjectType !== "hardware"
    )
  );
  assert.equal(
    firstPage.items.some((movement) =>
      secondPage.items.some((candidate) => candidate.id === movement.id)
    ),
    false
  );
  assert.ok(firstPage.chartItems.length <= 2_000);

  const searchable = firstPage.items[0];
  assert.ok(searchable);
  const searched = await queryMovements({
    page: 1,
    pageSize: 25,
    search: searchable.subjectName,
    checkpoint: searchable.checkpoint,
    sortKey: "createdAt",
    sortDirection: "desc",
  });
  assert.ok(searched.items.some((movement) => movement.id === searchable.id));
  assert.ok(
    searched.items.every(
      (movement) => movement.checkpoint === searchable.checkpoint
    )
  );
});

test("ignores denied movements when calculating worked sessions", () => {
  const movements: MovementEvent[] = [
    {
      id: "denied-entry",
      date: "Jul 28, 2026",
      time: "9:00:00 AM",
      checkpointId: "cp-main",
      checkpoint: "Main",
      direction: "entry",
      subjectId: "employee-1",
      subjectName: "Employee",
      subjectType: "employee",
      barcode: "EMP-1",
      result: "denied",
      scanType: "manual",
      syncState: "synced",
      hardwareIds: [],
      createdAt: "2026-07-28T03:30:00.000Z",
    },
    {
      id: "denied-exit",
      date: "Jul 28, 2026",
      time: "5:00:00 PM",
      checkpointId: "cp-main",
      checkpoint: "Main",
      direction: "exit",
      subjectId: "employee-1",
      subjectName: "Employee",
      subjectType: "employee",
      barcode: "EMP-1",
      result: "denied",
      scanType: "manual",
      syncState: "synced",
      hardwareIds: [],
      createdAt: "2026-07-28T11:30:00.000Z",
    },
  ];

  assert.deepEqual(getPersonSessions("employee-1", movements), []);
});

test("parses facility datetime-local values without falling back", () => {
  assert.equal(
    parseDateInput("2026-07-28T10:30"),
    Date.parse("2026-07-28T05:00:00.000Z")
  );
});

test("persists permission decisions and their audit record", async () => {
  const before = await getSnapshot("permissions");
  const request = before.permissionRequests.find(
    (item) => item.status === "pending"
  );
  assert.ok(request);

  const decided = await decidePermissionRequest(
    request.id,
    "approved",
    "Approved in integration test"
  );
  assert.equal(decided.request.status, "approved");

  const afterDecision = await getSnapshot("permissions");
  assert.equal(
    afterDecision.permissionRequests.find((item) => item.id === request.id)?.status,
    "approved"
  );
  assert.ok(
    afterDecision.auditEvents.some(
      (event) => event.relatedId === request.id && event.decision === "granted"
    )
  );
});

test("hashes credentials and verifies profile password changes server-side", async () => {
  const hash = hashPassword("correct horse battery staple", "fixed-test-salt");
  assert.equal(verifyPassword("correct horse battery staple", hash), true);
  assert.equal(verifyPassword("wrong password", hash), false);

  const profile = await getCurrentAdminProfile();
  await assert.rejects(
    () =>
      updateCurrentAdminProfile({
        ...profile,
        currentPassword: "incorrect",
        newPassword: "new-password-123",
      }),
    /current password is incorrect/i
  );

  const updated = await updateCurrentAdminProfile({
    ...profile,
    nickname: "Ops Test",
    currentPassword: "admin1234",
    newPassword: "new-password-123",
  });
  assert.equal(updated.nickname, "Ops Test");
});

test("persists registry records and permission deltas in PostgreSQL", async () => {
  const snapshot = await getSnapshot("all");
  const zone = snapshot.checkpoints[0]?.zone;
  assert.ok(zone);

  const employee = await createEmployee({
    name: "PostgreSQL Integration Employee",
    barcode: "PG-EMP-INTEGRATION",
    department: "Engineering",
    accessLevel: "Employee",
    allowedZone: zone,
  });
  const renamedEmployee = await updatePerson(employee.id, {
    name: "PostgreSQL Integration Employee Updated",
  });
  assert.equal(
    renamedEmployee.name,
    "PostgreSQL Integration Employee Updated"
  );

  const asset = await createHardwareAsset({
    name: "PostgreSQL Integration Laptop",
    barcode: "PG-HW-INTEGRATION",
    owner: renamedEmployee.name,
    category: "Laptop",
    allowedZone: zone,
    status: "active",
  });
  const updatedAsset = await updateHardwareAsset(asset.id, {
    status: "maintenance",
  });
  assert.equal(updatedAsset.status, "maintenance");

  const now = new Date();
  const visitor = await createTemporaryVisitor({
    name: "PostgreSQL Integration Visitor",
    barcode: "PG-VIS-INTEGRATION",
    company: "Integration Test",
    host: renamedEmployee.name,
    hours: 2,
    validFrom: now.toISOString(),
    validUntil: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    reason: "PostgreSQL integration test",
  });
  const permissionResult = await updateAccessPermission({
    subjectId: visitor.id,
    state: "active",
    zones: [zone],
    reason: "Approved by PostgreSQL integration test",
  });
  assert.equal(permissionResult.permission.state, "active");
  assert.equal(permissionResult.person?.status, "pre_approved");

  const registry = await getSnapshot("registry");
  assert.ok(registry.people.some((person) => person.id === employee.id));
  assert.ok(
    registry.hardwareAssets.some((candidate) => candidate.id === asset.id)
  );
});

test("persists alert, rule, and notification changes in PostgreSQL", async () => {
  const alertsSnapshot = await getSnapshot("alerts");
  const alert = alertsSnapshot.alerts[0];
  const rule = alertsSnapshot.alertRules[0];
  assert.ok(alert);
  assert.ok(rule);

  const updatedAlert = await updateAlert(alert.id, {
    status: "acknowledged",
  });
  assert.equal(updatedAlert.status, "acknowledged");
  const updatedRule = await updateAlertRule(rule.id, !rule.enabled);
  assert.equal(updatedRule.enabled, !rule.enabled);

  const permissionSnapshot = await getSnapshot("permissions");
  const notification = permissionSnapshot.notifications[0];
  assert.ok(notification);
  const readNotification = await markNotificationRead(notification.id);
  assert.equal(readNotification.read, true);
});

test("persists movement upserts, sync states, conflicts, and notes", async () => {
  const snapshot = await getSnapshot("all");
  const approved = snapshot.movements.find(
    (movement) => movement.result === "approved"
  );
  const denied = snapshot.movements.find(
    (movement) => movement.result === "denied"
  );
  assert.ok(approved);
  assert.ok(denied);

  const queuedApproved = await saveMovement({
    ...approved,
    id: "integration-queued-approved",
    syncState: "queued",
    createdAt: new Date().toISOString(),
  });
  const synced = await syncMovements([queuedApproved.id]);
  assert.equal(synced[0]?.syncState, "synced");

  const queuedDenied = await saveMovement({
    ...denied,
    id: "integration-queued-denied",
    syncState: "queued",
    createdAt: new Date().toISOString(),
  });
  const conflicted = await syncMovements([queuedDenied.id]);
  assert.equal(conflicted[0]?.syncState, "conflict");
  const resolved = await resolveMovementConflicts([queuedDenied.id]);
  assert.equal(resolved[0]?.syncState, "synced");

  const notes = await addMovementNote(
    queuedApproved.id,
    "PostgreSQL integration note"
  );
  assert.deepEqual(notes, ["PostgreSQL integration note"]);
});
