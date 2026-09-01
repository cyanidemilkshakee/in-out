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
  const createdBase = isoDaysFrom(anchor, -10);

  const people: Person[] = [
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
    }
  ];

  const hardwareAssets: HardwareAsset[] = [];

  const checkpoints: Checkpoint[] = [
    {
      id: "cp-main",
      name: "Main Entrance",
      mode: "auto",
      zone: "Main Entrance",
      online: true,
      createdAt: createdBase,
    }
  ];

  return {
    admins: [
      {
        id: "admin-1",
        name: "Admin User",
        nickname: "Admin",
        email: "admin@inout.local",
        password: "admin",
        avatarDataUrl: "",
        autoLock: "15",
        settings: { syncAlerts: true, weeklyDigest: false, requireReviewNote: false },
        createdAt: createdBase,
      },
    ],
    snapshot: {
      people,
      hardwareAssets,
      checkpoints,
      movements: [],
      movementNotes: {},
      alerts: [],
      scanAnalytics: getDashboardKPIs([], []),
      permissions: [],
      permissionRequests: [],
      notifications: [],
      alertRules: [],
      auditEvents: [],
    },
    anchor: anchor.toISOString(),
  };
}
