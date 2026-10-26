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

const MAX_BREAK_DURATION_MS = 2 * 60 * 60 * 1000;

function facilityDateParts(timestamp: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  }).formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour") % 24,
    minute: value("minute"),
    second: value("second"),
  };
}

function facilityDayKey(timestamp: number) {
  const parts = facilityDateParts(timestamp);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function facilityDateObject(timestamp: number) {
  const parts = facilityDateParts(timestamp);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

function facilityDecimalHour(timestamp: number) {
  const parts = facilityDateParts(timestamp);
  return parts.hour + parts.minute / 60 + parts.second / 3600;
}
// Main function to calculate a person's exact worked hours and sessions per day
function buildSessions(movements: MovementEvent[]): DayPattern[] {
  // Sort chronologically
  const sorted = [...movements].sort((a, b) => {
    return movementTimestamp(a) - movementTimestamp(b);
  });

  // Group by the facility's calendar day rather than the browser's local day.
  const grouped = new Map<string, { dateObj: Date; events: MovementEvent[] }>();
  for (const m of sorted) {
    const timestamp = movementTimestamp(m);
    if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
    const key = facilityDayKey(timestamp);
    const group = grouped.get(key);
    if (group) {
      group.events.push(m);
    } else {
      grouped.set(key, { dateObj: facilityDateObject(timestamp), events: [m] });
    }
  }

  const result: DayPattern[] = [];

  for (const { dateObj, events } of grouped.values()) {
    const date = facilityDayKey(dateObj.getTime());
    const sessions: Session[] = [];
    let currentEntry: number | null = null;
    let workedHours = 0;

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const decTime = facilityDecimalHour(movementTimestamp(e));
      if (!Number.isFinite(decTime)) continue;
      
      if (e.direction === "entry" && currentEntry === null) {
        currentEntry = decTime;
        
        // Only a short same-day exit-to-entry gap is considered a break.
        if (i > 0) {
          const prevExit = events[i - 1];
          if (prevExit.direction === "exit") {
            const gapMs = movementTimestamp(e) - movementTimestamp(prevExit);
            if (gapMs >= 0 && gapMs <= MAX_BREAK_DURATION_MS) {
              const prevExitTime = facilityDecimalHour(movementTimestamp(prevExit));
              sessions.push({ start: prevExitTime, end: currentEntry, type: "break", zIndex: 2 });
            }
          }
        }
      } else if (e.direction === "exit" && currentEntry !== null) {
        sessions.push({ start: currentEntry, end: decTime, type: "work", zIndex: 1 });
        workedHours += (decTime - currentEntry);
        currentEntry = null;
      }
    }

    // Only extend an open session to the real current time, and only for today.
    if (currentEntry !== null) {
      const now = Date.now();
      if (date === facilityDayKey(now)) {
        const end = facilityDecimalHour(now);
        if (end > currentEntry) {
          sessions.push({ start: currentEntry, end, type: "work", zIndex: 1 });
          workedHours += end - currentEntry;
        }
      }
    }

    const percentage = Math.round((workedHours / 8) * 100);
    result.push({
      dateStr: `${dateObj.getUTCDate()} ${MONTH_NAMES[dateObj.getUTCMonth()]}`,
      dateObj,
      percentage: Math.min(percentage, 100),
      sessions,
      workedHours
    });
  }

  // Return sorted descending by date so most recent is first
  return result.sort((a, b) => b.dateObj.getTime() - a.dateObj.getTime());
}

export function getPersonSessionIndex(
  movements: MovementEvent[]
): PersonSessionIndex {
  const approvedByPerson = new Map<string, MovementEvent[]>();
  for (const movement of movements) {
    if (movement.result !== "approved" || movement.subjectType !== "employee") {
      continue;
    }
    const existing = approvedByPerson.get(movement.subjectId);
    if (existing) {
      existing.push(movement);
    } else {
      approvedByPerson.set(movement.subjectId, [movement]);
    }
  }

  return new Map(
    [...approvedByPerson.entries()].map(([personId, personMovements]) => [
      personId,
      buildSessions(personMovements),
    ])
  );
}

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
