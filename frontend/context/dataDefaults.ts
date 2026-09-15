import type { AppDataSnapshot } from "../../lib/types";

export const emptyData: AppDataSnapshot = {
  people: [],
  hardwareAssets: [],
  checkpoints: [],
  movements: [],
  alerts: [],
  scanAnalytics: {
    totalScans: 0,
    totalApproved: 0,
    totalDenied: 0,
    totalEntries: 0,
    totalExits: 0,
    totalAutomatic: 0,
    totalManual: 0,
    totalRestricted: 0,
    totalExpired: 0,
    totalOtherDenied: 0,
    activeInside: 0,
  },
  movementNotes: {},
  permissions: [],
  permissionRequests: [],
  notifications: [],
  alertRules: [],
  auditEvents: [],
};
