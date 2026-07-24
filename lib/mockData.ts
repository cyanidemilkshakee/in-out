import type {
  AccessPermission,
  Alert,
  AlertRule,
  AuditEvent,
  Checkpoint,
  HardwareAsset,
  MovementEvent,
  Person,
  PermissionNotification,
  PermissionRequest,
  ScanAnalytics
  ,WorkdayStatus
} from "./types";



export const scanAnalytics: ScanAnalytics = {
  totalScans: 700,
  totalApproved: 450,
  totalDenied: 250,
  totalEntries: 250,
  totalExits: 200,
  totalAutomatic: 550,
  totalManual: 150,
  totalRestricted: 180,
  totalExpired: 70,
  activeInside: 50
};

export const checkpoints: Checkpoint[] = [
  {
    id: "cp-main",
    name: "Main Entrance",
    mode: "auto",
    zone: "All Zones",
    online: true
  },
  {
    id: "cp-warehouse",
    name: "Warehouse Gate",
    mode: "auto",
    zone: "Warehouse",
    online: true
  },
  {
    id: "cp-it-exit",
    name: "IT Lab Exit",
    mode: "exit",
    zone: "IT Lab",
    online: false
  },
  {
    id: "cp-server",
    name: "Server Room Exit",
    mode: "exit",
    zone: "Server Room",
    online: true
  }
];

export const scanners: any[] = [
  {
    id: "T-01",
    name: "Terminal-01",
    checkpointId: "cp-main",
    status: "online",
    lastSeen: "10:25:18 AM",
    version: "v1.4.2"
  },
  {
    id: "T-02",
    name: "Terminal-02",
    checkpointId: "cp-warehouse",
    status: "warning",
    lastSeen: "10:21:35 AM",
    version: "v1.4.1"
  }
];

export const people: Person[] = [
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
    inside: true
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
    inside: false
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
    inside: true
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
    inside: true
  },
  {
    id: "vis-9912",
    name: "Priya Shah",
    type: "visitor",
    barcode: "test2",
    company: "Acme Corp",
    phone: "+91 98765 43210",
    accessLevel: "Visitor",
    allowedZones: ["Main Entrance"],
    status: "pre_approved",
    host: "Jane Smith",
    purpose: "Client Meeting",
    validFrom: "Jul 6, 2026 09:00 AM",
    validTo: "Jul 6, 2026 06:00 PM",
    inside: false
  },
  {
    id: "vis-7712",
    name: "Tom Hanks",
    type: "visitor",
    barcode: "V-TEMP-7712",
    company: "Northwind",
    phone: "+91 98888 77712",
    accessLevel: "Visitor",
    allowedZones: ["Main Entrance"],
    status: "expired",
    host: "John Doe",
    purpose: "Vendor Review",
    validFrom: "Jul 5, 2026 09:00 AM",
    validTo: "Jul 5, 2026 06:00 PM",
    inside: false
  },
  {
    id: "vis-8841",
    name: "Alan Reed",
    type: "visitor",
    barcode: "V-TEMP-8841",
    company: "Acme Corp",
    phone: "+91 98765 43210",
    accessLevel: "Visitor",
    allowedZones: ["Main Entrance"],
    status: "inactive",
    host: "Jane Smith",
    purpose: "Client Meeting",
    validFrom: "Jul 6, 2026 09:00 AM",
    validTo: "Jul 6, 2026 06:00 PM",
    inside: false
  },
  {
    id: "vis-temp-6409",
    name: "Nisha Rao",
    type: "visitor",
    barcode: "V-TEMP-6409",
    company: "Helios Controls",
    phone: "+91 90000 06409",
    accessLevel: "Visitor",
    allowedZones: ["Main Entrance", "Conference Wing"],
    status: "pre_approved",
    host: "Michael Lee",
    purpose: "Temporary maintenance audit",
    validFrom: "Jul 12, 2026 10:00 AM",
    validTo: "Jul 12, 2026 04:00 PM",
    inside: false
  },
  {
    id: "vis-7201",
    name: "Julia Thompson",
    type: "visitor",
    barcode: "VIS-7201",
    company: "TechConf 2026",
    phone: "+91 90000 07201",
    accessLevel: "Visitor",
    allowedZones: ["Main Entrance", "Conference Wing"],
    status: "pending_approval",
    host: "Michael Lee",
    purpose: "Vendor meeting with Engineering",
    validFrom: "Jul 22, 2026 09:00 AM",
    validTo: "Jul 22, 2026 01:00 PM",
    inside: false
  }
];

export const hardwareAssets: HardwareAsset[] = [
  {
    id: "hw-2001",
    name: "Laptop-045",
    barcode: "test3",
    owner: "John Smith",
    assignedEmployeeId: "emp-1002",
    assignedEmployeeName: "John Smith",
    category: "Laptop",
    allowedZones: ["Main Entrance", "IT Lab"],
    status: "active",
    inside: true
  },
  {
    id: "hw-3002",
    name: "Projector-12",
    barcode: "H3002",
    owner: "Facilities",
    assignedEmployeeId: "emp-1001",
    assignedEmployeeName: "John Doe",
    category: "Projector",
    allowedZones: ["Main Entrance", "Auditorium"],
    status: "active",
    inside: false
  },
  {
    id: "hw-4007",
    name: "Chair-07",
    barcode: "H4007",
    owner: "Facilities",
    assignedEmployeeId: "emp-1001",
    assignedEmployeeName: "John Doe",
    category: "Furniture",
    allowedZones: ["Warehouse"],
    status: "restricted",
    inside: true
  },
  {
    id: "hw-5108",
    name: "MacBook-Pro-18",
    barcode: "H5108",
    owner: "Engineering",
    assignedEmployeeId: "emp-1003",
    assignedEmployeeName: "Michael Lee",
    category: "Laptop",
    allowedZones: ["Main Entrance", "IT Lab"],
    status: "active",
    inside: true
  },
  {
    id: "hw-6204",
    name: "Thermal-Camera-04",
    barcode: "H6204",
    owner: "Security",
    assignedEmployeeId: "emp-1004",
    assignedEmployeeName: "Sarah Connor",
    category: "Camera",
    allowedZones: ["Main Entrance", "Server Room"],
    status: "restricted",
    inside: false
  },
  {
    id: "hw-7311",
    name: "Access-Tablet-11",
    barcode: "H7311",
    owner: "Front Desk",
    assignedEmployeeId: "emp-1004",
    assignedEmployeeName: "Sarah Connor",
    category: "Tablet",
    allowedZones: ["Main Entrance"],
    status: "active",
    inside: true
  },
  {
    id: "hw-8450",
    name: "Network-Switch-50",
    barcode: "H8450",
    owner: "IT",
    assignedEmployeeId: "emp-1003",
    assignedEmployeeName: "Michael Lee",
    category: "Network",
    allowedZones: ["Server Room"],
    status: "maintenance",
    inside: true
  }
];

import initialMovementsData from "./initialMovements.json";
export const initialMovements: MovementEvent[] = initialMovementsData as MovementEvent[];

export const initialAlerts: Alert[] = [
  {
    id: "AL-2026-0512",
    severity: "critical",
    status: "open",
    title: "Visitor denied entrance",
    reason: "Not pre-approved",
    subjectName: "Alan Reed",
    barcode: "V-TEMP-8841",
    checkpoint: "Main Entrance",
    date: "Jul 14, 2026",
    time: "10:23:12 AM"
  },
  {
    id: "AL-2026-0511",
    severity: "high",
    status: "open",
    title: "Restricted hardware exit",
    reason: "Not permitted",
    subjectName: "Chair-07",
    barcode: "H4007",
    checkpoint: "Warehouse Gate",
    date: "Jul 14, 2026",
    time: "10:18:03 AM"
  },
  {
    id: "AL-2026-0510",
    severity: "critical",
    status: "open",
    title: "Unauthorized area access attempt",
    reason: "No access level",
    subjectName: "John Doe",
    barcode: "E-4819",
    checkpoint: "Server Room B",
    date: "Jul 14, 2026",
    time: "10:15:22 AM"
  },
  {
    id: "AL-2026-0508",
    severity: "medium",
    status: "resolved",
    title: "Expired visitor pass",
    reason: "Pass expired",
    subjectName: "Tom Hanks",
    barcode: "V-TEMP-7712",
    checkpoint: "Main Entrance",
    date: "Jul 14, 2026",
    time: "10:09:44 AM"
  }
];

export const initialPermissions: AccessPermission[] = [
  ...people.map((person) => ({
    id: `perm-${person.id}`,
    subjectId: person.id,
    subjectName: person.name,
    subjectType: person.type,
    assignment: person.type === "employee" ? `${person.department ?? "General"} employee` : "Visitor access",
    state:
      person.status === "pre_approved" || person.status === "active"
        ? "active" as const
        : person.status === "pending_approval"
          ? "pending_approval" as const
          : person.status === "expired"
            ? "expired" as const
            : person.status === "restricted"
              ? "restricted" as const
              : "revoked" as const,
    zones: [...person.allowedZones],
    validFrom: person.validFrom ?? "Jan 1, 2016",
    validTo: person.validTo ?? "No expiry",
    source: person.type === "visitor" ? "request" as const : "policy" as const,
    reason: person.status === "inactive" ? "Access removed by administrator" : undefined,
    updatedAt: "Jul 22, 2026 10:24 AM",
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
    state: asset.status === "restricted" ? "restricted" as const : "active" as const,
    zones: [...asset.allowedZones],
    validFrom: "Jan 1, 2026",
    validTo: "Dec 31, 2026",
    source: "policy" as const,
    updatedAt: "Jul 22, 2026 09:58 AM",
    updatedBy: "Asset Manager",
  })),
];

export const initialPermissionRequests: PermissionRequest[] = [
  {
    id: "REQ-VIS-7201",
    type: "visitor",
    subjectId: "vis-7201",
    subjectName: "Julia Thompson",
    requester: "Michael Lee",
    purpose: "Vendor meeting with Engineering",
    requestedZones: ["Main Entrance", "Conference Wing"],
    validFrom: "Jul 22, 2026 09:00 AM",
    validTo: "Jul 22, 2026 01:00 PM",
    status: "pending",
    createdAt: "Jul 22, 2026 10:16 AM",
  },
  {
    id: "REQ-HW-5108",
    type: "hardware_custody",
    subjectId: "hw-5108",
    subjectName: "MacBook-Pro-18",
    requester: "Sarah Connor",
    purpose: "Temporary off-site client demonstration",
    requestedZones: ["Main Entrance", "Off-site"],
    validFrom: "Jul 22, 2026 11:00 AM",
    validTo: "Jul 23, 2026 05:00 PM",
    status: "pending",
    createdAt: "Jul 22, 2026 10:09 AM",
    hardwareId: "hw-5108",
    carrierId: "emp-1004",
    carrierName: "Sarah Connor",
  },
];

export const initialNotifications: PermissionNotification[] = [
  {
    id: "NOT-1001",
    title: "Visitor approval requested",
    message: "Julia Thompson was created at the security terminal and needs access approval.",
    category: "approval_request",
    priority: "high",
    relatedId: "REQ-VIS-7201",
    href: "/admin/permissions?request=REQ-VIS-7201",
    createdAt: "Jul 22, 2026 10:16 AM",
    read: false,
  },
  {
    id: "NOT-1002",
    title: "Hardware custody approval requested",
    message: "Sarah Connor requested custody of MacBook-Pro-18, assigned to Michael Lee.",
    category: "approval_request",
    priority: "high",
    relatedId: "REQ-HW-5108",
    href: "/admin/permissions?request=REQ-HW-5108",
    createdAt: "Jul 22, 2026 10:09 AM",
    read: false,
  },
];

export const initialAlertRules: AlertRule[] = [
  {
    id: "RULE-EXIT-BALANCE",
    name: "Exit count exceeds entry count",
    description: "Triggers when approved exits outnumber approved entries within a day.",
    category: "presence_anomaly",
    severity: "high",
    enabled: true,
    scope: "All checkpoints / daily",
    conditionKey: "exit_balance",
    recentTriggers: 12,
  },
  {
    id: "RULE-NO-BREAK",
    name: "No break recorded by end of day",
    description: "Triggers after a six-hour shift ends with no qualifying break.",
    category: "operational",
    severity: "medium",
    enabled: true,
    scope: "All employees / end of shift",
    conditionKey: "no_break",
    recentTriggers: 31,
  },
  {
    id: "RULE-HARDWARE-CARRIER",
    name: "Unauthorized hardware carrier",
    description: "Triggers when hardware moves with someone other than its assignee.",
    category: "hardware_custody",
    severity: "high",
    enabled: true,
    scope: "All hardware / all exits",
    conditionKey: "unauthorized_hardware_carrier",
    recentTriggers: 7,
  },
  {
    id: "RULE-RESTRICTED-EMPLOYEE",
    name: "Restricted employee entry",
    description: "Triggers when a restricted employee attempts an entry scan.",
    category: "access_violation",
    severity: "high",
    enabled: true,
    scope: "All employees / all entries",
    conditionKey: "restricted_employee_entry",
    recentTriggers: 5,
  },
];

export const initialAuditEvents: AuditEvent[] = [
  {
    id: "AUD-1004",
    category: "permission",
    action: "Manual permission granted",
    subjectId: "emp-1001",
    subjectName: "John Doe",
    actor: "Admin User",
    role: "Administrator",
    decision: "granted",
    reason: "Restored Main Entrance access after review.",
    relatedId: "perm-emp-1001",
    date: "Jul 22, 2026",
    time: "10:24 AM",
    createdAt: "2026-07-22T10:24:00+05:30",
  },
  {
    id: "AUD-1003",
    category: "permission",
    action: "Visitor request denied",
    subjectId: "vis-8841",
    subjectName: "Alan Reed",
    actor: "Admin User",
    role: "Administrator",
    decision: "denied",
    reason: "Host could not verify the meeting.",
    relatedId: "perm-vis-8841",
    date: "Jul 22, 2026",
    time: "10:12 AM",
    createdAt: "2026-07-22T10:12:00+05:30",
  },
  {
    id: "AUD-1002",
    category: "permission",
    action: "Hardware restricted",
    subjectId: "hw-4007",
    subjectName: "Chair-07",
    actor: "Asset Manager",
    role: "Administrator",
    decision: "denied",
    reason: "Warehouse-only asset.",
    relatedId: "perm-hw-4007",
    date: "Jul 22, 2026",
    time: "9:58 AM",
    createdAt: "2026-07-22T09:58:00+05:30",
  },
  {
    id: "AUD-1001",
    category: "permission",
    action: "Employee entry denied",
    subjectId: "emp-1004",
    subjectName: "Sarah Connor",
    actor: "Admin User",
    role: "Administrator",
    decision: "denied",
    reason: "Temporary restricted-zone hold.",
    relatedId: "perm-emp-1004",
    date: "Jul 22, 2026",
    time: "9:41 AM",
    createdAt: "2026-07-22T09:41:00+05:30",
  },
];

export const initialWorkdayStatuses: WorkdayStatus[] = [
  {
    employeeId: "emp-1001",
    employeeName: "John Doe",
    date: "Jul 14, 2026",
    breakMinutes: 0,
    minutesInside: 540,
    shiftEnded: true,
  },
  {
    employeeId: "emp-1003",
    employeeName: "Michael Lee",
    date: "Jul 14, 2026",
    breakMinutes: 42,
    minutesInside: 510,
    shiftEnded: true,
  },
];
