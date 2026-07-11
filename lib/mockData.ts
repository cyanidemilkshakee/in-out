import type {
  Alert,
  Checkpoint,
  HardwareAsset,
  MovementEvent,
  Person,
  ScanAnalytics,
  Scanner
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
  }
];
