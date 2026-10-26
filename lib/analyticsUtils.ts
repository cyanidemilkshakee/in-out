import type { AnalyticsPeriod, MovementEvent, Person, ScanAnalytics } from "./types";

const RESTRICTED_DENIAL_CODES = new Set([
  "asset_restricted",
  "access_restricted",
  "hardware_restricted",
  "zone_not_permitted",
  "cross_building_access",
  "expired_pass",
]);

export function isRestrictedDenialCode(code?: string) {
  return Boolean(code && RESTRICTED_DENIAL_CODES.has(code));
}

export const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export interface Session {
  start: number;
  end: number;
  type: "work" | "break";
  zIndex: number;
}

export interface DayPattern {
  dateStr: string;
  dateObj: Date;
  percentage: number;
  sessions: Session[];
  workedHours: number;
}

export type PersonSessionIndex = Map<string, DayPattern[]>;
// Function to get the overall Dashboard KPIs
export const getDashboardKPIs = (
  movements: MovementEvent[],
  people: Person[] = []
): ScanAnalytics => {
  let totalEntries = 0;
  let totalExits = 0;
  let totalApproved = 0;
  let totalDenied = 0;
  let totalAutomatic = 0;
  let totalManual = 0;
  let totalRestricted = 0;

  for (const m of movements) {
    if (m.result === "approved") {
      totalApproved++;
      if (m.direction === "entry") totalEntries++;
      if (m.direction === "exit") totalExits++;
    } else {
      totalDenied++;
      if (isRestrictedDenialCode(m.denialCode)) totalRestricted++;
    }

    if (m.scanType === "auto") {
      totalAutomatic++;
    } else {
      totalManual++;
    }
  }

  return {
    totalScans: movements.length,
    totalApproved,
    totalDenied,
    totalEntries,
    totalExits,
    totalAutomatic,
    totalManual,
    totalRestricted,
    totalOtherDenied: Math.max(0, totalDenied - totalRestricted),
    activeInside:
      people.length > 0
        ? people.reduce((count, person) => count + (person.inside ? 1 : 0), 0)
        : Math.max(0, totalEntries - totalExits),
  };
};
// Function for DrillDownDoughnut multi-level scan breakdown
export const getDrillDownData = (movements: MovementEvent[]) => {
  let approvedAutoEntry = 0, approvedAutoExit = 0;
  let approvedManualEntry = 0, approvedManualExit = 0;
  let deniedAutoRestricted = 0;
  let deniedManualRestricted = 0;
  let deniedAutoOther = 0, deniedManualOther = 0;
  
  let approved = 0, denied = 0;
  let autoApp = 0, manualApp = 0;
  let autoDen = 0, manualDen = 0;

  for (const m of movements) {
    if (m.result === "approved") {
      approved++;
      if (m.scanType === "auto") {
        autoApp++;
        if (m.direction === "entry") approvedAutoEntry++;
        else approvedAutoExit++;
      } else {
        manualApp++;
        if (m.direction === "entry") approvedManualEntry++;
        else approvedManualExit++;
      }
    } else {
      denied++;
      const restricted = isRestrictedDenialCode(m.denialCode);
      if (m.scanType === "auto") {
        autoDen++;
        if (restricted) deniedAutoRestricted++;
        else deniedAutoOther++;
      } else {
        manualDen++;
        if (restricted) deniedManualRestricted++;
        else deniedManualOther++;
      }
    }
  }

  return {
    totalScans: movements.length,
    sections: [
      {
        id: "approved",
        label: "Approved",
        value: approved,
        children: [
          {
            id: "automaticApproved",
            label: "Automatic",
            value: autoApp,
            children: [
              { id: "autoEntry", label: "Entries", value: approvedAutoEntry },
              { id: "autoExit", label: "Exits", value: approvedAutoExit }
            ]
          },
          {
            id: "manualApproved",
            label: "Manual",
            value: manualApp,
            children: [
              { id: "manualEntry", label: "Entries", value: approvedManualEntry },
              { id: "manualExit", label: "Exits", value: approvedManualExit }
            ]
          }
        ]
      },
      {
        id: "denied",
        label: "Denied",
        value: denied,
        children: [
          {
            id: "automaticDenied",
            label: "Automatic",
            value: autoDen,
            children: [
              { id: "restrictedAuto", label: "Restricted", value: deniedAutoRestricted },
              { id: "otherAuto", label: "Other", value: deniedAutoOther },
            ]
          },
          {
            id: "manualDenied",
            label: "Manual",
            value: manualDen,
            children: [
              { id: "restrictedManual", label: "Restricted", value: deniedManualRestricted },
              { id: "otherManual", label: "Other", value: deniedManualOther },
            ]
          }
        ]
      }
    ]
  };
};

/** The same drilldown shape, populated from complete server counters. */
export function getAggregateDrillDownData(period: AnalyticsPeriod) {
  const shape = getDrillDownData([]);
  const values = { ...period.breakdown, approved: period.scanAnalytics.totalApproved,
    denied: period.scanAnalytics.totalDenied };
  const assign = (node: (typeof shape.sections)[number]): void => {
    node.value = values[node.id as keyof typeof values] ?? 0;
    if ("children" in node) node.children.forEach(child => assign(child as typeof node));
  };
  shape.sections.forEach(assign);
  return { ...shape, totalScans: period.scanAnalytics.totalScans };
}
