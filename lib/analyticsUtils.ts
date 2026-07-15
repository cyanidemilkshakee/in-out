import { initialMovements } from "./mockData";
import { MovementEvent, Person } from "./types";

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

// Helper to convert time string (e.g. "5:59:38 PM") to decimal hours
export const timeToDecimal = (timeStr: string): number => {
  const [time, period] = timeStr.split(" ");
  let [hours, minutes] = time.split(":").map(Number);
  if (period === "PM" && hours !== 12) hours += 12;
  if (period === "AM" && hours === 12) hours = 0;
  return hours + minutes / 60;
};

// Main function to calculate a person's exact worked hours and sessions per day
export const getPersonSessions = (personId: string): DayPattern[] => {
  const userMovements = initialMovements.filter((m) => m.subjectId === personId);
  
  // Sort chronologically
  const sorted = [...userMovements].sort((a, b) => {
    return new Date(`${a.date} ${a.time}`).getTime() - new Date(`${b.date} ${b.time}`).getTime();
  });

  // Group by date string
  const grouped: Record<string, MovementEvent[]> = {};
  for (const m of sorted) {
    if (!grouped[m.date]) grouped[m.date] = [];
    grouped[m.date].push(m);
  }

  const result: DayPattern[] = [];
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

    // If they never exited by the end of the day, assume they are still working (mock it to current time if today, or a default 8h shift)
    if (currentEntry !== null) {
       // Just cap it at 17.0 (5 PM) for charting purposes if it's open-ended
       const end = Math.max(currentEntry + 1, 17);
       sessions.push({ start: currentEntry, end, type: "work", zIndex: 1 });
       workedHours += (end - currentEntry);
    }

    const percentage = Math.round((workedHours / 8) * 100);
    const d = new Date(date);

    result.push({
      dateStr: `${d.getDate()} ${monthNames[d.getMonth()]}`,
      dateObj: d,
      percentage: Math.min(percentage, 100),
      sessions,
      workedHours
    });
  }

  // Return sorted descending by date so most recent is first
  return result.sort((a, b) => b.dateObj.getTime() - a.dateObj.getTime());
};

// Function for the dashboard to get aggregate entries/exits per day
export const getDailyMovementCounts = (daysToLookBack: number = 14) => {
  const now = new Date();
  const counts: Record<string, { entries: number, exits: number }> = {};
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Initialize the last N days with 0 counts
  for (let i = daysToLookBack - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const dateStr = `${d.getDate()} ${monthNames[d.getMonth()]}`;
    counts[dateStr] = { entries: 0, exits: 0 };
  }

  // Populate counts from real data
  const cutoffTime = new Date(now);
  cutoffTime.setDate(now.getDate() - daysToLookBack);

  for (const m of initialMovements) {
    const d = new Date(`${m.date} ${m.time}`);
    if (d >= cutoffTime) {
      const dateStr = `${d.getDate()} ${monthNames[d.getMonth()]}`;
      if (counts[dateStr]) {
        if (m.direction === "entry") counts[dateStr].entries++;
        if (m.direction === "exit") counts[dateStr].exits++;
      }
    }
  }

  return counts;
};

// Function for the dashboard DrillDownDoughnut to get zone activity
export const getZoneActivity = () => {
  const zoneCounts: Record<string, number> = {};
  for (const m of initialMovements) {
    // Some checkpoints are zones (e.g. Warehouse). We can just use the checkpoint name directly.
    const name = m.checkpoint || "Unknown";
    zoneCounts[name] = (zoneCounts[name] || 0) + 1;
  }
  
  // Return top 4 zones + "Other"
  const sorted = Object.entries(zoneCounts).sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 4);
  const otherSum = sorted.slice(4).reduce((sum, [_, count]) => sum + count, 0);
  
  if (otherSum > 0) top.push(["Other", otherSum]);
  
  return top.map(([label, value]) => ({ label, value }));
};

// Function to get the overall Dashboard KPIs
export const getDashboardKPIs = () => {
  let totalEntries = 0;
  let totalExits = 0;
  let totalApproved = 0;
  let totalDenied = 0;
  let totalAutomatic = 0;
  let totalManual = 0;

  for (const m of initialMovements) {
    if (m.direction === "entry") totalEntries++;
    if (m.direction === "exit") totalExits++;
    
    if (m.result === "approved") {
      totalApproved++;
    } else {
      totalDenied++;
    }

    if (m.scanType === "auto") {
      totalAutomatic++;
    } else {
      totalManual++;
    }
  }

  return {
    totalScans: initialMovements.length,
    totalApproved,
    totalDenied,
    totalEntries,
    totalExits,
    totalAutomatic,
    totalManual,
    totalRestricted: Math.round(totalDenied * 0.7), // Mocked split for denied
    totalExpired: Math.round(totalDenied * 0.3),    // Mocked split for denied
    activeInside: Math.max(0, totalEntries - totalExits) // Mocked active inside
  };
};

// Function for DrillDownDoughnut multi-level scan breakdown
export const getDrillDownData = () => {
  let approvedAutoEntry = 0, approvedAutoExit = 0;
  let approvedManualEntry = 0, approvedManualExit = 0;
  let deniedAutoRestricted = 0, deniedAutoExpired = 0;
  let deniedManualRestricted = 0, deniedManualExpired = 0;
  
  let approved = 0, denied = 0;
  let autoApp = 0, manualApp = 0;
  let autoDen = 0, manualDen = 0;

  for (const m of initialMovements) {
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
      // We don't have exact restricted/expired reasons in the data easily available, so we mock the split based on total
      if (m.scanType === "auto") {
        autoDen++;
        if (Math.random() > 0.3) deniedAutoRestricted++;
        else deniedAutoExpired++;
      } else {
        manualDen++;
        if (Math.random() > 0.3) deniedManualRestricted++;
        else deniedManualExpired++;
      }
    }
  }

  return {
    totalScans: initialMovements.length,
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
              { id: "expiredAuto", label: "Expired", value: deniedAutoExpired }
            ]
          },
          {
            id: "manualDenied",
            label: "Manual",
            value: manualDen,
            children: [
              { id: "restrictedManual", label: "Restricted", value: deniedManualRestricted },
              { id: "expiredManual", label: "Expired", value: deniedManualExpired }
            ]
          }
        ]
      }
    ]
  };
};

// Employee Dashboard Analytics

export const getEmployeeKPIs = (peopleList: Person[]) => {
  const employees = peopleList.filter(p => p.type === 'employee');
  const totalEmployees = employees.length;
  const insideEmployees = employees.filter(p => p.inside).length;
  
  // A simplistic mock for late/absences: 
  // In a real app we'd compare scheduled shifts to actual entries.
  // Here we mock it deterministically based on total headcount to make it look realistic.
  const lateOrAbsent = Math.floor(totalEmployees * 0.08); // e.g. 8% are late/absent

  return {
    totalEmployees,
    insideEmployees,
    lateOrAbsent
  };
};

export const getDepartmentStats = (peopleList: Person[]) => {
  const employees = peopleList.filter(p => p.type === 'employee');
  const deptCounts: Record<string, number> = {};
  
  employees.forEach(emp => {
    const dept = emp.department || 'Unassigned';
    deptCounts[dept] = (deptCounts[dept] || 0) + 1;
  });

  return {
    labels: Object.keys(deptCounts),
    data: Object.values(deptCounts)
  };
};

export const getAverageShiftLengths = (timeRange: "1W" | "1M" | "1Y" = "1W") => {
  const labels: string[] = [];
  const averages: number[] = [];
  // We'll calculate the average shift length per day across all employees over the given time range
  let days = 7;
  if (timeRange === "1M") days = 30;
  if (timeRange === "1Y") days = 365;

  const now = new Date();
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const cutoffTime = new Date(now);
  cutoffTime.setDate(now.getDate() - days);
  
  // Build a map of date string -> array of shift lengths
  const dailyShifts: Record<string, number[]> = {};
  
  // Just take a sample of unique employees from movements
  const uniqueEmployeeIds = Array.from(new Set(initialMovements.filter(m => m.subjectType === 'employee').map(m => m.subjectId)));
  
  // To avoid huge computation freezing the UI, we sample up to 50 employees
  const sampleIds = uniqueEmployeeIds.slice(0, 50);
  
  sampleIds.forEach(empId => {
    const sessions = getPersonSessions(empId);
    sessions.forEach(dayPattern => {
      if (dayPattern.workedHours > 0 && dayPattern.dateObj >= cutoffTime) {
        const dateStr = `${dayPattern.dateObj.getDate()} ${monthNames[dayPattern.dateObj.getMonth()]}`;
        if (!dailyShifts[dateStr]) dailyShifts[dateStr] = [];
        dailyShifts[dateStr].push(dayPattern.workedHours);
      }
    });
  });

  if (timeRange === "1Y") {
    // 12 months buckets
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now);
      d.setMonth(d.getMonth() - i);
      labels.push(monthNames[d.getMonth()]);
      
      let sum = 0;
      let count = 0;
      Object.keys(dailyShifts).forEach(dateStr => {
         if (dateStr.endsWith(monthNames[d.getMonth()])) {
            sum += dailyShifts[dateStr].reduce((a,b) => a+b, 0);
            count += dailyShifts[dateStr].length;
         }
      });
      averages.push(count > 0 ? Number((sum/count).toFixed(1)) : 0);
    }
  } else {
    // 1W or 1M
    const step = timeRange === "1M" ? 3 : 1;
    for (let i = days - 1; i >= 0; i -= step) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      labels.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      
      let sum = 0;
      let count = 0;
      for (let j = 0; j < step; j++) {
         const curr = new Date(now);
         curr.setDate(now.getDate() - (i - j));
         const dateStr = `${curr.getDate()} ${monthNames[curr.getMonth()]}`;
         if (dailyShifts[dateStr]) {
            sum += dailyShifts[dateStr].reduce((a,b) => a+b, 0);
            count += dailyShifts[dateStr].length;
         }
      }
      averages.push(count > 0 ? Number((sum/count).toFixed(1)) : 0);
    }
  }

  return { labels, data: averages };
};
