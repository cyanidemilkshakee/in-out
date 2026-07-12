import type {
  Alert,
  ActivePresence,
  Checkpoint,
  EmployeeRecord,
  HardwareAsset,
  MovementEvent,
  Person,
  RoleRecord,
  ScanAnalytics,
  Scanner,
  ShiftPolicy,
  UserRecord,
  OfflineSyncBatch
} from "./types";

export const roles: RoleRecord[] = [
  {
    id: "role-admin",
    name: "Admin",
    permissions: ["manage_users", "manage_policy", "view_all_movements", "resolve_alerts"]
  },
  {
    id: "role-security",
    name: "Security Operator",
    permissions: ["scan_subjects", "manual_review", "sync_offline_batches"]
  },
  {
    id: "role-auditor",
    name: "Auditor",
    permissions: ["view_movements", "export_reports"]
  }
];

export const users: UserRecord[] = [
  {
    id: "usr-001",
    roleId: "role-admin",
    email: "admin@company.com",
    displayName: "Ops Admin",
    status: "active"
  },
  {
    id: "usr-002",
    roleId: "role-security",
    email: "terminal@company.com",
    displayName: "Security Staff",
    status: "active"
  },
  {
    id: "usr-003",
    roleId: "role-auditor",
    email: "audit@company.com",
    displayName: "Compliance Review",
    status: "active"
  }
];

export const shiftPolicies: ShiftPolicy[] = [
  {
    id: "shift-day",
    name: "Day Shift",
    rules: ["entry_after_08_00", "exit_before_19_00", "visitor_host_required"],
    status: "active"
  },
  {
    id: "shift-security",
    name: "Security Rotation",
    rules: ["manual_override_allowed", "offline_sync_allowed", "checkpoint_handoff_required"],
    status: "active"
  },
  {
    id: "shift-it",
    name: "IT Restricted",
    rules: ["server_room_requires_it_admin", "asset_exit_requires_review"],
    status: "active"
  }
];

export const employeeRecords: EmployeeRecord[] = [
  {
    id: "emp-rec-1001",
    userId: "usr-001",
    shiftPolicyId: "shift-day",
    employeeCode: "E1001",
    name: "John Doe",
    department: "Facilities",
    status: "active",
    createdAt: "2026-07-01T09:00:00+05:30"
  },
  {
    id: "emp-rec-1003",
    userId: "usr-003",
    shiftPolicyId: "shift-it",
    employeeCode: "E1003",
    name: "Michael Lee",
    department: "IT",
    status: "active",
    createdAt: "2026-07-02T10:30:00+05:30"
  },
  {
    id: "emp-rec-1004",
    userId: "usr-002",
    shiftPolicyId: "shift-security",
    employeeCode: "E1004",
    name: "Sarah Connor",
    department: "Security",
    status: "active",
    createdAt: "2026-07-03T08:45:00+05:30"
  }
];

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
    scannerId: "T-01",
    online: true
  },
  {
    id: "cp-warehouse",
    name: "Warehouse Gate",
    mode: "auto",
    zone: "Warehouse",
    scannerId: "T-02",
    online: true
  },
  {
    id: "cp-it-exit",
    name: "IT Lab Exit",
    mode: "exit",
    zone: "IT Lab",
    scannerId: "T-03",
    online: false
  },
  {
    id: "cp-server",
    name: "Server Room Exit",
    mode: "exit",
    zone: "Server Room",
    scannerId: "T-04",
    online: true
  }
];

export const scanners: Scanner[] = [
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
  }
];

export const hardwareAssets: HardwareAsset[] = [
  {
    id: "hw-2001",
    name: "Laptop-045",
    barcode: "test3",
    owner: "John Smith",
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
    category: "Furniture",
    allowedZones: ["Warehouse"],
    status: "restricted",
    inside: true
  }
];

export const initialMovements: MovementEvent[] = [
  {
    id: "EVT-000987",
    time: "10:25:18 AM",
    checkpointId: "cp-main",
    checkpoint: "Main Entrance",
    direction: "entry",
    subjectId: "emp-1002",
    subjectName: "John Smith",
    subjectType: "employee",
    barcode: "test1",
    result: "success",
    reason: "-",
    scannerId: "T-01",
    syncState: "synced",
    hardwareIds: []
  },
  {
    id: "EVT-000986",
    time: "10:23:58 AM",
    checkpointId: "cp-main",
    checkpoint: "Main Entrance",
    direction: "entry",
    subjectId: "emp-1001",
    subjectName: "John Doe",
    subjectType: "employee",
    barcode: "E1001",
    result: "success",
    reason: "-",
    scannerId: "T-01",
    syncState: "synced",
    hardwareIds: []
  },
  {
    id: "EVT-000985",
    time: "10:23:12 AM",
    checkpointId: "cp-main",
    checkpoint: "Main Entrance",
    direction: "entry",
    subjectId: "vis-8841",
    subjectName: "Alan Reed",
    subjectType: "visitor",
    barcode: "V-TEMP-8841",
    result: "denied",
    reason: "Not pre-approved",
    scannerId: "T-01",
    syncState: "synced",
    hardwareIds: []
  },
  {
    id: "EVT-000984",
    time: "10:22:45 AM",
    checkpointId: "cp-it-exit",
    checkpoint: "IT Lab Exit",
    direction: "exit",
    subjectId: "emp-1003",
    subjectName: "Michael Lee",
    subjectType: "employee",
    barcode: "E1003",
    result: "success",
    reason: "-",
    scannerId: "T-03",
    syncState: "synced",
    hardwareIds: []
  },
  {
    id: "EVT-000983",
    time: "10:21:35 AM",
    checkpointId: "cp-warehouse",
    checkpoint: "Warehouse Gate",
    direction: "exit",
    subjectId: "hw-2001",
    subjectName: "Laptop-045",
    subjectType: "hardware",
    barcode: "test3",
    result: "manual_review",
    reason: "Asset not expected out",
    scannerId: "T-02",
    syncState: "queued",
    hardwareIds: []
  },
  {
    id: "EVT-000982",
    time: "10:20:44 AM",
    checkpointId: "cp-main",
    checkpoint: "Main Entrance",
    direction: "entry",
    subjectId: "emp-1001",
    subjectName: "John Doe",
    subjectType: "employee",
    barcode: "E1001",
    result: "duplicate",
    reason: "Already inside",
    scannerId: "T-01",
    syncState: "synced",
    hardwareIds: []
  },
  {
    id: "EVT-000981",
    time: "10:19:22 AM",
    checkpointId: "cp-main",
    checkpoint: "Main Entrance",
    direction: "entry",
    subjectId: "vis-7712",
    subjectName: "Tom Hanks",
    subjectType: "visitor",
    barcode: "V-TEMP-7712",
    result: "expired",
    reason: "Pass expired",
    scannerId: "T-01",
    syncState: "synced",
    hardwareIds: []
  },
  {
    id: "EVT-000980",
    time: "10:18:03 AM",
    checkpointId: "cp-warehouse",
    checkpoint: "Warehouse Gate",
    direction: "exit",
    subjectId: "hw-4007",
    subjectName: "Chair-07",
    subjectType: "hardware",
    barcode: "H4007",
    result: "restricted",
    reason: "Not permitted",
    scannerId: "T-02",
    syncState: "queued",
    hardwareIds: []
  }
];

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
    time: "10:18:03 AM"
  },
  {
    id: "AL-2026-0510",
    severity: "medium",
    status: "open",
    title: "Unauthorized area access attempt",
    reason: "No access level",
    subjectName: "John Doe",
    barcode: "E-4819",
    checkpoint: "Server Room B",
    time: "10:15:22 AM"
  },
  {
    id: "AL-2026-0509",
    severity: "high",
    status: "acknowledged",
    title: "Offline scan conflict",
    reason: "Queued denial requires reconciliation",
    subjectName: "Laptop-045",
    barcode: "test3",
    checkpoint: "Warehouse Gate",
    time: "10:11:08 AM"
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
    time: "10:09:44 AM"
  }
];

export const activePresence: ActivePresence[] = [
  {
    id: "presence-001",
    employeeId: "emp-1001",
    checkpointId: "cp-main",
    movementTransactionId: "EVT-000986",
    state: "inside",
    enteredAt: "10:23:58 AM"
  },
  {
    id: "presence-002",
    employeeId: "emp-1003",
    checkpointId: "cp-it-exit",
    movementTransactionId: "EVT-000984",
    state: "inside",
    enteredAt: "10:22:45 AM"
  },
  {
    id: "presence-003",
    hardwareItemId: "hw-4007",
    checkpointId: "cp-warehouse",
    movementTransactionId: "EVT-000980",
    state: "held",
    enteredAt: "10:18:03 AM"
  }
];

export const offlineSyncBatches: OfflineSyncBatch[] = [
  {
    id: "batch-2026-0712-01",
    deviceId: "T-02",
    checkpointId: "cp-warehouse",
    status: "received",
    receivedAt: "10:21:42 AM",
    conflictCount: 1
  },
  {
    id: "batch-2026-0712-02",
    deviceId: "T-03",
    checkpointId: "cp-it-exit",
    status: "replayed",
    receivedAt: "10:12:08 AM",
    resolvedAt: "10:14:55 AM",
    conflictCount: 0
  },
  {
    id: "batch-2026-0712-03",
    deviceId: "T-01",
    checkpointId: "cp-main",
    status: "conflict",
    receivedAt: "10:09:44 AM",
    conflictCount: 2
  }
];
