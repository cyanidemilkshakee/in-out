import type {
  Alert,
  Checkpoint,
  HardwareAsset,
  MovementEvent,
  Person,
  ScanAnalytics
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
  },
  {
    id: "hw-5108",
    name: "MacBook-Pro-18",
    barcode: "H5108",
    owner: "Engineering",
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
