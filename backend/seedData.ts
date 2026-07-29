import { getDashboardKPIs } from "../lib/analyticsUtils";
import type {
  AccessPermission,
  Alert,
  AlertRule,
  AuditEvent,
  Checkpoint,
  DenialCode,
  HardwareAsset,
  MovementEvent,
  Person,
  PermissionNotification,
  PermissionRequest,
  SubjectType,
} from "../lib/types";
import type { AppDataSnapshot } from "../lib/types";

const FACILITY_TIME_ZONE = "Asia/Kolkata";
const DAY_IN_MS = 24 * 60 * 60 * 1000;

export type SeedAdmin = {
  id: string;
  name: string;
  nickname: string;
  email: string;
  password: string;
  avatarDataUrl: string;
  autoLock: string;
  settings: {
    syncAlerts: boolean;
    weeklyDigest: boolean;
    requireReviewNote: boolean;
  };
  createdAt: string;
};

export type SeedBundle = {
  snapshot: AppDataSnapshot;
  admins: SeedAdmin[];
  anchor: string;
};

type FacilityDateParts = { year: number; month: number; day: number };

function mulberry32(seed: number) {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function facilityParts(date: Date): FacilityDateParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: FACILITY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function facilityTimestamp(
  date: FacilityDateParts,
  hour: number,
  minute: number,
  second = 0
) {
  return new Date(
    Date.UTC(date.year, date.month - 1, date.day, hour - 5, minute - 30, second)
  );
}

function displayDate(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: FACILITY_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function displayTime(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: FACILITY_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function isoDaysFrom(anchor: Date, days: number) {
  return new Date(anchor.getTime() + days * DAY_IN_MS).toISOString();
}

function denialDetails(code: DenialCode): { reason: string; title: string } {
  const details: Record<DenialCode, { reason: string; title: string }> = {
    barcode_not_registered: {
      reason: "Barcode not registered",
      title: "Unknown barcode attempt",
    },
    asset_restricted: { reason: "Asset restricted", title: "Restricted asset movement" },
    access_restricted: {
      reason: "Employee access restricted",
      title: "Restricted employee entry attempt",
    },
    access_inactive: {
      reason: "Employee access inactive",
      title: "Inactive employee access attempt",
    },
    expired_pass: { reason: "Temporary barcode expired", title: "Expired visitor pass" },
    approval_pending: {
      reason: "Temporary visitor approval pending",
      title: "Visitor approval pending",
    },
    not_preapproved: { reason: "Not pre-approved", title: "Visitor denied entrance" },
    hardware_restricted: {
      reason: "Carried hardware is restricted",
      title: "Restricted hardware movement",
    },
    custody_mismatch: {
      reason: "Hardware assigned to another employee; custody approval required",
      title: "Unauthorized hardware carrier",
    },
    zone_not_permitted: {
      reason: "Checkpoint zone not permitted",
      title: "Unauthorized area access attempt",
    },
    already_inside: { reason: "Already inside", title: "Duplicate entry attempt" },
    no_active_entry: { reason: "No active entry found", title: "Unmatched exit attempt" },
    asset_not_expected_out: {
      reason: "Asset not expected out",
      title: "Unexpected asset exit",
    },
    manual_review: {
      reason: "Security escalated for manual review",
      title: "Manual review required",
    },
  };
  return details[code];
}

function newestPresence(
  subjectId: string,
  movements: MovementEvent[],
  fallback: boolean
) {
  const latest = movements.find(
    (movement) => movement.subjectId === subjectId && movement.result === "approved"
  );
  return latest ? latest.direction === "entry" : fallback;
}

export function buildSeedData(anchorInput = new Date()): SeedBundle {
  const anchor = new Date(anchorInput);
  const random = mulberry32(20260728);
  const createdBase = isoDaysFrom(anchor, -240);

  let people: Person[] = [
    {
      id: "emp-1001",
      name: "John Doe",
      type: "employee",
      barcode: "E1001",
      department: "Facilities",
      phone: "+91 91234 56780",
      accessLevel: "Employee",
      allowedZones: ["All Zones"],
      status: "active",
      inside: false,
      createdAt: createdBase,
    },
    {
      id: "emp-1002",
      name: "John Smith",
      type: "employee",
      barcode: "test1",
      department: "Engineering",
      phone: "+91 91234 56789",
      accessLevel: "Employee",
      allowedZones: ["All Zones"],
      status: "active",
      inside: false,
      createdAt: isoDaysFrom(anchor, -220),
    },
    {
      id: "emp-1003",
      name: "Michael Lee",
      type: "employee",
      barcode: "E1003",
      department: "IT",
      phone: "+91 95555 13003",
      accessLevel: "IT Admin",
      allowedZones: ["All Zones", "IT Lab", "Server Room"],
      status: "active",
      inside: false,
      createdAt: isoDaysFrom(anchor, -205),
    },
    {
      id: "emp-1004",
      name: "Sarah Connor",
      type: "employee",
      barcode: "E1004",
      department: "Security",
      phone: "+91 96666 11004",
      accessLevel: "Security",
      allowedZones: ["Main Entrance", "Warehouse"],
      status: "active",
      inside: false,
      createdAt: isoDaysFrom(anchor, -190),
    },
    {
      id: "emp-1005",
      name: "Aarav Mehta",
      type: "employee",
      barcode: "E1005",
      department: "Finance",
      phone: "+91 97777 21005",
      accessLevel: "Employee",
      allowedZones: ["Main Entrance", "Conference Wing"],
      status: "active",
      inside: false,
      createdAt: isoDaysFrom(anchor, -175),
    },
    {
      id: "emp-1006",
      name: "Maya Nair",
      type: "employee",
      barcode: "E1006",
      department: "Operations",
      phone: "+91 98888 31006",
      accessLevel: "Operations",
      allowedZones: ["Main Entrance", "Warehouse"],
      status: "active",
      inside: false,
      createdAt: isoDaysFrom(anchor, -160),
    },
    {
      id: "emp-1007",
      name: "Rohan Kapoor",
      type: "employee",
      barcode: "E1007",
      department: "Engineering",
      phone: "+91 90000 41007",
      accessLevel: "Employee",
      allowedZones: ["Main Entrance", "IT Lab"],
      status: "restricted",
      inside: false,
      createdAt: isoDaysFrom(anchor, -145),
    },
    {
      id: "emp-1008",
      name: "Leena Patel",
      type: "employee",
      barcode: "E1008",
      department: "HR",
      phone: "+91 91111 51008",
      accessLevel: "Employee",
      allowedZones: ["Main Entrance", "Conference Wing"],
      status: "active",
      inside: false,
      createdAt: isoDaysFrom(anchor, -130),
    },
    {
      id: "vis-2001",
      name: "Priya Shah",
      type: "visitor",
      barcode: "test2",
      company: "Acme Corp",
      phone: "+91 98765 43210",
      accessLevel: "Visitor",
      allowedZones: ["Main Entrance", "Conference Wing"],
      status: "pre_approved",
      host: "John Smith",
      purpose: "Client meeting",
      validFrom: isoDaysFrom(anchor, -1),
      validTo: isoDaysFrom(anchor, 2),
      inside: false,
      createdAt: isoDaysFrom(anchor, -30),
    },
    {
      id: "vis-2002",
      name: "Tom Hanks",
      type: "visitor",
      barcode: "V-TEMP-2002",
      company: "Northwind",
      phone: "+91 98888 72002",
      accessLevel: "Visitor",
      allowedZones: ["Main Entrance"],
      status: "expired",
      host: "John Doe",
      purpose: "Vendor review",
      validFrom: isoDaysFrom(anchor, -10),
      validTo: isoDaysFrom(anchor, -9),
      inside: false,
      createdAt: isoDaysFrom(anchor, -45),
    },
    {
      id: "vis-2003",
      name: "Nisha Rao",
      type: "visitor",
      barcode: "V-TEMP-2003",
      company: "Helios Controls",
      phone: "+91 90000 62003",
      accessLevel: "Visitor",
      allowedZones: ["Main Entrance", "Conference Wing"],
      status: "pre_approved",
      host: "Michael Lee",
      purpose: "Maintenance audit",
      validFrom: isoDaysFrom(anchor, -2),
      validTo: isoDaysFrom(anchor, 1),
      inside: false,
      createdAt: isoDaysFrom(anchor, -28),
    },
    {
      id: "vis-2004",
      name: "Julia Thompson",
      type: "visitor",
      barcode: "V-TEMP-2004",
      company: "TechConf",
      phone: "+91 90000 72004",
      accessLevel: "Visitor",
      allowedZones: ["Main Entrance"],
      status: "pending_approval",
      host: "Maya Nair",
      purpose: "Vendor meeting",
      validFrom: anchor.toISOString(),
      validTo: isoDaysFrom(anchor, 1),
      inside: false,
      createdAt: isoDaysFrom(anchor, -2),
    },
    {
      id: "vis-2005",
      name: "Alan Reed",
      type: "visitor",
      barcode: "V-TEMP-2005",
      company: "Globex",
      phone: "+91 90000 82005",
      accessLevel: "Visitor",
      allowedZones: ["Main Entrance"],
      status: "inactive",
      host: "Leena Patel",
      purpose: "Interview",
      validFrom: isoDaysFrom(anchor, -20),
      validTo: isoDaysFrom(anchor, -19),
      inside: false,
      createdAt: isoDaysFrom(anchor, -50),
    },
  ];

  let hardwareAssets: HardwareAsset[] = [
    {
      id: "hw-3001",
      name: "Laptop-045",
      barcode: "test3",
      owner: "John Smith",
      assignedEmployeeId: "emp-1002",
      assignedEmployeeName: "John Smith",
      category: "Laptop",
      allowedZones: ["Main Entrance", "IT Lab"],
      status: "active",
      inside: false,
      createdAt: isoDaysFrom(anchor, -210),
    },
    {
      id: "hw-3002",
      name: "Projector-12",
      barcode: "H3002",
      owner: "Facilities",
      assignedEmployeeId: "emp-1001",
      assignedEmployeeName: "John Doe",
      category: "Projector",
      allowedZones: ["Main Entrance", "Conference Wing"],
      status: "active",
      inside: false,
      createdAt: isoDaysFrom(anchor, -200),
    },
    {
      id: "hw-3003",
      name: "Thermal-Camera-04",
      barcode: "H3003",
      owner: "Security",
      assignedEmployeeId: "emp-1004",
      assignedEmployeeName: "Sarah Connor",
      category: "Camera",
      allowedZones: ["Main Entrance", "Server Room"],
      status: "restricted",
      inside: false,
      createdAt: isoDaysFrom(anchor, -185),
    },
    {
      id: "hw-3004",
      name: "Access-Tablet-11",
      barcode: "H3004",
      owner: "Front Desk",
      assignedEmployeeId: "emp-1004",
      assignedEmployeeName: "Sarah Connor",
      category: "Tablet",
      allowedZones: ["Main Entrance"],
      status: "active",
      inside: false,
      createdAt: isoDaysFrom(anchor, -170),
    },
    {
      id: "hw-3005",
      name: "Network-Switch-50",
      barcode: "H3005",
      owner: "IT",
      assignedEmployeeId: "emp-1003",
      assignedEmployeeName: "Michael Lee",
      category: "Network",
      allowedZones: ["Server Room"],
      status: "maintenance",
      inside: false,
      createdAt: isoDaysFrom(anchor, -155),
    },
    {
      id: "hw-3006",
      name: "MacBook-Pro-18",
      barcode: "H3006",
      owner: "Engineering",
      assignedEmployeeId: "emp-1006",
      assignedEmployeeName: "Maya Nair",
      category: "Laptop",
      allowedZones: ["Main Entrance", "IT Lab"],
      status: "active",
      inside: false,
      createdAt: isoDaysFrom(anchor, -140),
    },
  ];

  const checkpoints: Checkpoint[] = [
    {
      id: "cp-main",
      name: "Main Entrance",
      mode: "auto",
      zone: "Main Entrance",
      online: true,
      createdAt: createdBase,
    },
    {
      id: "cp-north",
      name: "North Gate",
      mode: "auto",
      zone: "Main Entrance",
      online: true,
      createdAt: createdBase,
    },
    {
      id: "cp-south",
      name: "South Gate",
      mode: "auto",
      zone: "Main Entrance",
      online: true,
      createdAt: createdBase,
    },
    {
      id: "cp-warehouse",
      name: "Warehouse Gate",
      mode: "auto",
      zone: "Warehouse",
      online: true,
      createdAt: createdBase,
    },
    {
      id: "cp-it-exit",
      name: "IT Lab Exit",
      mode: "exit",
      zone: "IT Lab",
      online: true,
      createdAt: createdBase,
    },
    {
      id: "cp-server",
      name: "Server Room Exit",
      mode: "exit",
      zone: "Server Room",
      online: true,
      createdAt: createdBase,
    },
  ];
  const checkpointById = new Map(checkpoints.map((item) => [item.id, item]));
  const movements: MovementEvent[] = [];
  let eventSequence = 1;

  function addMovement({
    timestamp,
    checkpointId,
    direction,
    subjectId,
    subjectName,
    subjectType,
    barcode,
    result = "approved",
    denialCode,
    scanType = "auto",
    hardwareIds = [],
    reason,
  }: {
    timestamp: Date;
    checkpointId: string;
    direction: "entry" | "exit";
    subjectId: string;
    subjectName: string;
    subjectType: SubjectType;
    barcode: string;
    result?: "approved" | "denied";
    denialCode?: DenialCode;
    scanType?: "auto" | "manual";
    hardwareIds?: string[];
    reason?: string;
  }) {
    if (timestamp.getTime() > anchor.getTime()) return;
    const checkpoint = checkpointById.get(checkpointId);
    if (!checkpoint) throw new Error(`Seed checkpoint ${checkpointId} is missing.`);
    const denial = denialCode ? denialDetails(denialCode) : undefined;
    movements.push({
      id: `EVT-${String(eventSequence++).padStart(6, "0")}`,
      date: displayDate(timestamp),
      time: displayTime(timestamp),
      checkpointId,
      checkpoint: checkpoint.name,
      direction,
      subjectId,
      subjectName,
      subjectType,
      barcode,
      result,
      reason: reason ?? denial?.reason ?? "-",
      denialCode,
      scanType,
      syncState: "synced",
      hardwareIds,
      createdAt: timestamp.toISOString(),
    });
  }

  const employees = people.filter((person) => person.type === "employee");
  const visitors = people.filter((person) => person.type === "visitor");

  for (let daysAgo = 119; daysAgo >= 0; daysAgo -= 1) {
    const dayDate = new Date(anchor.getTime() - daysAgo * DAY_IN_MS);
    const date = facilityParts(dayDate);
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    const workday = weekday >= 1 && weekday <= 5;

    if (workday) {
      employees.forEach((employee, employeeIndex) => {
        if (employee.status !== "active" || random() < 0.04) return;
        const entryMinute = 15 + Math.floor(random() * 55);
        const checkpointId = employeeIndex % 3 === 0 ? "cp-north" : "cp-main";
        addMovement({
          timestamp: facilityTimestamp(date, 8, entryMinute, employeeIndex),
          checkpointId,
          direction: "entry",
          subjectId: employee.id,
          subjectName: employee.name,
          subjectType: "employee",
          barcode: employee.barcode,
          scanType: random() < 0.82 ? "auto" : "manual",
        });

        if ((daysAgo + employeeIndex) % 17 === 0) {
          addMovement({
            timestamp: facilityTimestamp(date, 10, 20 + employeeIndex, employeeIndex),
            checkpointId: "cp-server",
            direction: "exit",
            subjectId: employee.id,
            subjectName: employee.name,
            subjectType: "employee",
            barcode: employee.barcode,
            result: "denied",
            denialCode: "zone_not_permitted",
            scanType: "manual",
          });
        }

        if ((daysAgo + employeeIndex) % 3 !== 0) {
          addMovement({
            timestamp: facilityTimestamp(date, 13, 0 + employeeIndex, employeeIndex),
            checkpointId,
            direction: "exit",
            subjectId: employee.id,
            subjectName: employee.name,
            subjectType: "employee",
            barcode: employee.barcode,
          });
          addMovement({
            timestamp: facilityTimestamp(date, 13, 35 + employeeIndex, employeeIndex),
            checkpointId,
            direction: "entry",
            subjectId: employee.id,
            subjectName: employee.name,
            subjectType: "employee",
            barcode: employee.barcode,
          });
        }

        const staysInside = daysAgo === 0 && employeeIndex < 3;
        if (!staysInside) {
          addMovement({
            timestamp: facilityTimestamp(
              date,
              17,
              5 + Math.floor(random() * 70),
              employeeIndex
            ),
            checkpointId,
            direction: "exit",
            subjectId: employee.id,
            subjectName: employee.name,
            subjectType: "employee",
            barcode: employee.barcode,
            scanType: random() < 0.82 ? "auto" : "manual",
          });
        }
      });
    }

    if (daysAgo % 2 === 0) {
      const visitor = visitors[(daysAgo / 2) % visitors.length];
      const approved = visitor.status === "pre_approved";
      const denialCode: DenialCode | undefined = approved
        ? undefined
        : visitor.status === "expired"
          ? "expired_pass"
          : visitor.status === "pending_approval"
            ? "approval_pending"
            : "not_preapproved";
      addMovement({
        timestamp: facilityTimestamp(date, 10, 10 + (daysAgo % 35)),
        checkpointId: "cp-main",
        direction: "entry",
        subjectId: visitor.id,
        subjectName: visitor.name,
        subjectType: "visitor",
        barcode: visitor.barcode,
        result: approved ? "approved" : "denied",
        denialCode,
        scanType: daysAgo % 4 === 0 ? "manual" : "auto",
      });
      if (approved && daysAgo !== 0) {
        addMovement({
          timestamp: facilityTimestamp(date, 15, 15 + (daysAgo % 30)),
          checkpointId: "cp-main",
          direction: "exit",
          subjectId: visitor.id,
          subjectName: visitor.name,
          subjectType: "visitor",
          barcode: visitor.barcode,
          scanType: "manual",
        });
      }
    }

    if (daysAgo % 3 === 0) {
      const asset = hardwareAssets[(daysAgo / 3) % hardwareAssets.length];
      const restricted = asset.status !== "active";
      addMovement({
        timestamp: facilityTimestamp(date, 9, 25 + (daysAgo % 25)),
        checkpointId: asset.allowedZones.includes("Warehouse") ? "cp-warehouse" : "cp-main",
        direction: "entry",
        subjectId: asset.id,
        subjectName: asset.name,
        subjectType: "hardware",
        barcode: asset.barcode,
        result: restricted ? "denied" : "approved",
        denialCode: restricted ? "asset_restricted" : undefined,
        scanType: "manual",
      });
      if (!restricted && daysAgo !== 0) {
        addMovement({
          timestamp: facilityTimestamp(date, 16, 40 + (daysAgo % 15)),
          checkpointId: "cp-main",
          direction: "exit",
          subjectId: asset.id,
          subjectName: asset.name,
          subjectType: "hardware",
          barcode: asset.barcode,
          scanType: "manual",
        });
      }
    }
  }

  movements.sort(
    (left, right) =>
      new Date(right.createdAt ?? 0).getTime() - new Date(left.createdAt ?? 0).getTime()
  );
  people = people.map((person) => ({
    ...person,
    inside: newestPresence(person.id, movements, person.inside),
  }));
  hardwareAssets = hardwareAssets.map((asset) => ({
    ...asset,
    inside: newestPresence(asset.id, movements, asset.inside),
  }));

  const deniedMovements = movements.filter((movement) => movement.result === "denied");
  const alerts: Alert[] = deniedMovements.slice(0, 80).map((movement, index) => {
    const denial = denialDetails(movement.denialCode ?? "manual_review");
    return {
      id: `AL-${String(index + 1).padStart(5, "0")}`,
      severity:
        movement.denialCode === "custody_mismatch" || movement.denialCode === "access_restricted"
          ? "critical"
          : movement.denialCode === "expired_pass"
            ? "medium"
            : "high",
      status: index % 5 === 0 ? "resolved" : index % 4 === 0 ? "acknowledged" : "open",
      title: denial.title,
      reason: movement.reason ?? denial.reason,
      subjectName: movement.subjectName,
      barcode: movement.barcode,
      checkpoint: movement.checkpoint,
      date: movement.date,
      time: movement.time,
      category:
        movement.subjectType === "hardware" ? "hardware_custody" : "access_violation",
      explanation: `Generated from ${movement.denialCode ?? "manual review"} policy evidence.`,
      sourceEventId: movement.id,
      createdAt: movement.createdAt,
    };
  });

  const alertRules: AlertRule[] = [
    {
      id: "rule-exit-balance",
      name: "Exit balance",
      description: "Raise an alert when approved exits exceed approved entries.",
      category: "presence_anomaly",
      severity: "high",
      enabled: true,
      scope: "All checkpoints",
      conditionKey: "exit_balance",
      recentTriggers: 0,
    },
    {
      id: "rule-no-break",
      name: "No break recorded",
      description: "Flag long completed shifts without a recorded break.",
      category: "operational",
      severity: "medium",
      enabled: true,
      scope: "Employees",
      conditionKey: "no_break",
      recentTriggers: 3,
    },
    {
      id: "rule-hardware-carrier",
      name: "Hardware custody mismatch",
      description: "Raise an alert when hardware is carried by a different employee.",
      category: "hardware_custody",
      severity: "critical",
      enabled: true,
      scope: "Tracked hardware",
      conditionKey: "unauthorized_hardware_carrier",
      recentTriggers: 2,
    },
    {
      id: "rule-restricted-employee",
      name: "Restricted employee entry",
      description: "Raise an alert when a restricted employee attempts entry.",
      category: "access_violation",
      severity: "critical",
      enabled: true,
      scope: "Employees",
      conditionKey: "restricted_employee_entry",
      recentTriggers: 1,
    },
  ];

  const permissions: AccessPermission[] = [
    ...people.map((person) => ({
      id: `perm-${person.id}`,
      subjectId: person.id,
      subjectName: person.name,
      subjectType: person.type,
      assignment:
        person.type === "employee"
          ? `${person.department ?? "General"} employee`
          : "Visitor access",
      state:
        person.status === "active" || person.status === "pre_approved"
          ? ("active" as const)
          : person.status === "pending_approval"
            ? ("pending_approval" as const)
            : person.status === "expired"
              ? ("expired" as const)
              : person.status === "restricted"
                ? ("restricted" as const)
                : ("revoked" as const),
      zones: [...person.allowedZones],
      validFrom: person.validFrom ?? createdBase,
      validTo: person.validTo ?? "No expiry",
      source: person.type === "visitor" ? ("request" as const) : ("policy" as const),
      reason: person.status === "inactive" ? "Access removed by administrator" : undefined,
      updatedAt: anchor.toISOString(),
      updatedBy: person.type === "visitor" ? "Permission Manager" : "System policy",
    })),
    ...hardwareAssets.map((asset) => ({
      id: `perm-${asset.id}`,
      subjectId: asset.id,
      subjectName: asset.name,
      subjectType: "hardware" as const,
      assignment: asset.assignedEmployeeName
        ? `Assigned to ${asset.assignedEmployeeName}`
        : asset.owner,
      state:
        asset.status === "restricted" ? ("restricted" as const) : ("active" as const),
      zones: [...asset.allowedZones],
      validFrom: asset.createdAt ?? createdBase,
      validTo: "No expiry",
      source: "policy" as const,
      updatedAt: anchor.toISOString(),
      updatedBy: "Asset Manager",
    })),
  ];

  const pendingVisitor = people.find((person) => person.status === "pending_approval")!;
  const permissionRequests: PermissionRequest[] = [
    {
      id: "REQ-VIS-2004",
      type: "visitor",
      subjectId: pendingVisitor.id,
      subjectName: pendingVisitor.name,
      requester: pendingVisitor.host ?? "Security Desk",
      purpose: pendingVisitor.purpose ?? "Visitor access",
      requestedZones: [...pendingVisitor.allowedZones],
      validFrom: pendingVisitor.validFrom ?? anchor.toISOString(),
      validTo: pendingVisitor.validTo ?? isoDaysFrom(anchor, 1),
      status: "pending",
      createdAt: pendingVisitor.createdAt ?? anchor.toISOString(),
    },
  ];

  const notifications: PermissionNotification[] = [
    {
      id: "NOT-0001",
      title: "Visitor approval requested",
      message: `${pendingVisitor.name} needs temporary access approval.`,
      category: "approval_request",
      priority: "high",
      relatedId: permissionRequests[0].id,
      href: `/admin/permissions?request=${permissionRequests[0].id}`,
      createdAt: permissionRequests[0].createdAt,
      read: false,
    },
  ];

  const auditEvents: AuditEvent[] = deniedMovements.slice(0, 30).map((movement, index) => ({
    id: `AUD-${String(index + 1).padStart(5, "0")}`,
    category: "movement",
    action: "Access decision denied",
    subjectId: movement.subjectId,
    subjectName: movement.subjectName,
    actor: movement.scanType === "manual" ? "Security Operator" : "Rule Engine",
    role: movement.scanType === "manual" ? "Security" : "System",
    decision: "denied",
    reason: movement.reason ?? "Policy denied the movement.",
    relatedId: movement.id,
    date: movement.date,
    time: movement.time,
    createdAt: movement.createdAt ?? anchor.toISOString(),
  }));

  const snapshot: AppDataSnapshot = {
    people,
    hardwareAssets,
    checkpoints,
    movements,
    alerts,
    scanAnalytics: getDashboardKPIs(movements, people),
    movementNotes: {},
    permissions,
    permissionRequests,
    notifications,
    alertRules,
    auditEvents,
  };

  return {
    snapshot,
    admins: [
      {
        id: "admin-default",
        name: "Admin",
        nickname: "ops-admin",
        email: "admin@company.com",
        password: "admin1234",
        avatarDataUrl: "",
        autoLock: "15",
        settings: {
          syncAlerts: true,
          weeklyDigest: false,
          requireReviewNote: true,
        },
        createdAt: createdBase,
      },
    ],
    anchor: anchor.toISOString(),
  };
}
