import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  closeDatabaseForTests,
  verifyPassword,
  hashPassword,
} from "../backend/database";
import {
  decidePermissionRequest,
  getSnapshot,
  queryMovements,
  recordScan,
} from "../backend/dataRepository";
import {
  getCurrentAdminProfile,
  updateCurrentAdminProfile,
} from "../backend/profileRepository";
import { buildSeedData } from "../backend/seedData";
import { getPersonSessions } from "../lib/analyticsUtils";
import { parseDateInput } from "../lib/dateRanges";
import type { MovementEvent } from "../lib/types";

const databaseDirectory = mkdtempSync(path.join(tmpdir(), "inout-backend-test-"));
process.env.INOUT_DB_PATH = path.join(databaseDirectory, "inout.sqlite");

after(() => {
  closeDatabaseForTests();
  rmSync(databaseDirectory, { recursive: true, force: true });
});

test("seeds coherent scoped snapshots from SQLite", () => {
  const all = getSnapshot("all");
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

  const profileScope = getSnapshot("profile");
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

test("records approved and denied scans as persistent movements", () => {
  const before = getSnapshot("all");
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

  const approved = recordScan({
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

  const denied = recordScan({
    barcode: "NOT-A-REAL-BARCODE",
    checkpointId: checkpoint.id,
    selectedHardwareIds: [],
    online: true,
    scanType: "manual",
  });
  assert.equal(denied.decision.event.result, "denied");
  assert.equal(denied.decision.event.denialCode, "barcode_not_registered");

  const afterScans = getSnapshot("all");
  assert.equal(afterScans.movements.length, before.movements.length + 2);
  assert.ok(
    afterScans.movements.some(
      (movement) => movement.id === denied.decision.event.id
    )
  );
});

test("filters and paginates movement queries in SQLite", () => {
  const firstPage = queryMovements({
    page: 1,
    pageSize: 10,
    result: "approved",
    subjectGroup: "people",
    sortKey: "createdAt",
    sortDirection: "desc",
  });
  const secondPage = queryMovements({
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

test("persists permission decisions and their audit record", () => {
  const before = getSnapshot("permissions");
  const request = before.permissionRequests.find(
    (item) => item.status === "pending"
  );
  assert.ok(request);

  const decided = decidePermissionRequest(
    request.id,
    "approved",
    "Approved in integration test"
  );
  assert.equal(decided.request.status, "approved");

  const afterDecision = getSnapshot("permissions");
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

test("hashes credentials and verifies profile password changes server-side", () => {
  const hash = hashPassword("correct horse battery staple", "fixed-test-salt");
  assert.equal(verifyPassword("correct horse battery staple", hash), true);
  assert.equal(verifyPassword("wrong password", hash), false);

  const profile = getCurrentAdminProfile();
  assert.throws(
    () =>
      updateCurrentAdminProfile({
        ...profile,
        currentPassword: "incorrect",
        newPassword: "new-password-123",
      }),
    /current password is incorrect/i
  );

  const updated = updateCurrentAdminProfile({
    ...profile,
    nickname: "Ops Test",
    currentPassword: "admin1234",
    newPassword: "new-password-123",
  });
  assert.equal(updated.nickname, "Ops Test");
});
