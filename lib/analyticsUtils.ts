import type { MovementEvent, Person, ScanAnalytics } from "./types";

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

export function movementTimestamp(movement: MovementEvent) {
  const timestamp = movement.createdAt
    ? new Date(movement.createdAt).getTime()
    : new Date(`${movement.date} ${movement.time}`).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}


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

// Helper to convert time string (e.g. "5:59:38 PM") to decimal hours
export const timeToDecimal = (timeStr: string): number => {
  const [time, period] = timeStr.split(" ");
  let [hours, minutes] = time.split(":").map(Number);
  if (period === "PM" && hours !== 12) hours += 12;
  if (period === "AM" && hours === 12) hours = 0;
  return hours + minutes / 60;
};
// Main function to calculate a person's exact worked hours and sessions per day
export const getPersonSessions = (
  personId: string,
  movements: MovementEvent[]
): DayPattern[] => {
  const approvedMovements = movements.filter(
    (movement) =>
      movement.subjectId === personId && movement.result === "approved"
  );
  return buildSessions(approvedMovements);
};

function buildSessions(movements: MovementEvent[]): DayPattern[] {
  // Sort chronologically
  const sorted = [...movements].sort((a, b) => {
    return movementTimestamp(a) - movementTimestamp(b);
  });

  // Group by date string
  const grouped: Record<string, MovementEvent[]> = {};
  for (const m of sorted) {
    if (!grouped[m.date]) grouped[m.date] = [];
    grouped[m.date].push(m);
  }

  const result: DayPattern[] = [];

  for (const date of Object.keys(grouped)) {
    const events = grouped[date];
    const sessions: Session[] = [];
    let currentEntry: number | null = null;
    let workedHours = 0;

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const decTime = timeToDecimal(e.time);
      
      if (e.direction === "entry" && currentEntry === null) {
        currentEntry = decTime;
        
        // If there was a previous exit on this same day, the gap is a break!
        if (i > 0) {
          const prevExit = events[i - 1];
          if (prevExit.direction === "exit") {
            const prevExitTime = timeToDecimal(prevExit.time);
            sessions.push({ start: prevExitTime, end: currentEntry, type: "break", zIndex: 2 });
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
      const now = new Date();
      const facilityDate = now.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      });
      if (date === facilityDate) {
        const facilityTime = now.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
          hour12: true,
          timeZone: "Asia/Kolkata",
        });
        const end = timeToDecimal(facilityTime);
        if (end > currentEntry) {
          sessions.push({ start: currentEntry, end, type: "work", zIndex: 1 });
          workedHours += end - currentEntry;
        }
      }
    }

    const percentage = Math.round((workedHours / 8) * 100);
    const d = new Date(date);

    result.push({
      dateStr: `${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`,
      dateObj: d,
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
  let totalExpired = 0;

  for (const m of movements) {
    if (m.result === "approved") {
      totalApproved++;
      if (m.direction === "entry") totalEntries++;
      if (m.direction === "exit") totalExits++;
    } else {
      totalDenied++;
      if (m.denialCode === "expired_pass") {
        totalExpired++;
      } else if (
        m.denialCode === "asset_restricted" ||
        m.denialCode === "access_restricted" ||
        m.denialCode === "hardware_restricted" ||
        m.denialCode === "zone_not_permitted"
      ) {
        totalRestricted++;
      }
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
    totalExpired,
    totalOtherDenied: Math.max(0, totalDenied - totalRestricted - totalExpired),
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
  let deniedAutoRestricted = 0, deniedAutoExpired = 0;
  let deniedManualRestricted = 0, deniedManualExpired = 0;
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
      const restricted =
        m.denialCode === "asset_restricted" ||
        m.denialCode === "access_restricted" ||
        m.denialCode === "hardware_restricted" ||
        m.denialCode === "zone_not_permitted";
      const expired = m.denialCode === "expired_pass";
      if (m.scanType === "auto") {
        autoDen++;
        if (restricted) deniedAutoRestricted++;
        else if (expired) deniedAutoExpired++;
        else deniedAutoOther++;
      } else {
        manualDen++;
        if (restricted) deniedManualRestricted++;
        else if (expired) deniedManualExpired++;
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
              { id: "expiredAuto", label: "Expired", value: deniedAutoExpired },
              { id: "otherAuto", label: "Other", value: deniedAutoOther },
            ]
          },
          {
            id: "manualDenied",
            label: "Manual",
            value: manualDen,
            children: [
              { id: "restrictedManual", label: "Restricted", value: deniedManualRestricted },
              { id: "expiredManual", label: "Expired", value: deniedManualExpired },
              { id: "otherManual", label: "Other", value: deniedManualOther },
            ]
          }
        ]
      }
    ]
  };
};
