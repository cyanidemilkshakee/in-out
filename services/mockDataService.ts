import { getDashboardKPIs } from "../lib/analyticsUtils";
import {
  checkpoints,
  initialAlertRules,
  hardwareAssets,
  initialAlerts,
  initialAuditEvents,
  initialMovements,
  initialNotifications,
  initialPermissionRequests,
  initialPermissions,
  initialWorkdayStatuses,
  people,
} from "../lib/mockData";
import { applyMovementState, evaluateScan } from "../lib/movementLogic";
import { createScanAlert, evaluateScheduledRules } from "../lib/ruleEngine";
import type {
  AccessPermission,
  Alert,
  AlertRule,
  AuditEvent,
  HardwareAsset,
  MovementEvent,
  Person,
  PermissionNotification,
  PermissionRequest,
} from "../lib/types";
import type {
  AppDataSnapshot,
  CreateEmployeeInput,
  CreateHardwareAssetInput,
  CreateTemporaryVisitorInput,
  DataService,
  MovementNotes,
  RecordScanInput,
  RecordScanResult,
  UpdateAccessPermissionInput,
} from "./dataService";

function clonePeople(items: Person[]) {
  return items.map((item) => ({ ...item, allowedZones: [...item.allowedZones] }));
}

function cloneHardware(items: HardwareAsset[]) {
  return items.map((item) => ({ ...item, allowedZones: [...item.allowedZones] }));
}

function cloneMovements(items: MovementEvent[]) {
  return items.map((item) => ({ ...item, hardwareIds: [...item.hardwareIds] }));
}

function cloneAlerts(items: Alert[]) {
  return items.map((item) => ({ ...item }));
}

function clonePermissions(items: AccessPermission[]) {
  return items.map((item) => ({ ...item, zones: [...item.zones] }));
}

function clonePermissionRequests(items: PermissionRequest[]) {
  return items.map((item) => ({ ...item, requestedZones: [...item.requestedZones] }));
}

function cloneNotifications(items: PermissionNotification[]) {
  return items.map((item) => ({ ...item }));
}

function cloneAlertRules(items: AlertRule[]) {
  return items.map((item) => ({ ...item }));
}

function cloneAuditEvents(items: AuditEvent[]) {
  return items.map((item) => ({ ...item }));
}

function facilityDate(date = new Date()) {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

function facilityTime(date = new Date()) {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}

function cloneNotes(notes: MovementNotes) {
  return Object.fromEntries(
    Object.entries(notes).map(([eventId, entries]) => [eventId, [...entries]])
  );
}

export function createMockDataSnapshot(): AppDataSnapshot {
  const movements = cloneMovements(initialMovements);
  const baseAlerts = cloneAlerts(initialAlerts);
  const scheduledAlerts = evaluateScheduledRules({
    rules: initialAlertRules,
    movements,
    workdays: initialWorkdayStatuses,
    existingAlerts: baseAlerts,
  });
  return {
    people: clonePeople(people),
    hardwareAssets: cloneHardware(hardwareAssets),
    checkpoints: checkpoints.map((item) => ({ ...item })),
    movements,
    alerts: [...scheduledAlerts, ...baseAlerts],
    scanAnalytics: getDashboardKPIs(movements),
    movementNotes: {},
    permissions: clonePermissions(initialPermissions),
    permissionRequests: clonePermissionRequests(initialPermissionRequests),
    notifications: cloneNotifications(initialNotifications),
    alertRules: cloneAlertRules(initialAlertRules),
    auditEvents: cloneAuditEvents(initialAuditEvents),
  };
}

export class MockDataService implements DataService {
  private people: Person[];
  private hardwareAssets: HardwareAsset[];
  private checkpoints: AppDataSnapshot["checkpoints"];
  private movements: MovementEvent[];
  private alerts: Alert[];
  private movementNotes: MovementNotes;
  private permissions: AccessPermission[];
  private permissionRequests: PermissionRequest[];
  private notifications: PermissionNotification[];
  private alertRules: AlertRule[];
  private auditEvents: AuditEvent[];

  constructor(initialData: AppDataSnapshot = createMockDataSnapshot()) {
    this.people = clonePeople(initialData.people);
    this.hardwareAssets = cloneHardware(initialData.hardwareAssets);
    this.checkpoints = initialData.checkpoints.map((item) => ({ ...item }));
    this.movements = cloneMovements(initialData.movements);
    this.alerts = cloneAlerts(initialData.alerts);
    this.movementNotes = cloneNotes(initialData.movementNotes);
    this.permissions = clonePermissions(initialData.permissions);
    this.permissionRequests = clonePermissionRequests(initialData.permissionRequests);
    this.notifications = cloneNotifications(initialData.notifications);
    this.alertRules = cloneAlertRules(initialData.alertRules);
    this.auditEvents = cloneAuditEvents(initialData.auditEvents);
  }

  async getPeople() {
    return clonePeople(this.people);
  }

  async getHardwareAssets() {
    return cloneHardware(this.hardwareAssets);
  }

  async getCheckpoints() {
    return this.checkpoints.map((item) => ({ ...item }));
  }

  async getMovements() {
    return cloneMovements(this.movements);
  }

  async getAlerts() {
    return cloneAlerts(this.alerts);
  }

  async getScanAnalytics() {
    return getDashboardKPIs(this.movements);
  }

  async getMovementNotes() {
    return cloneNotes(this.movementNotes);
  }

  async getPermissions() {
    return clonePermissions(this.permissions);
  }

  async getPermissionRequests() {
    return clonePermissionRequests(this.permissionRequests);
  }

  async getNotifications() {
    return cloneNotifications(this.notifications);
  }

  async getAlertRules() {
    return cloneAlertRules(this.alertRules);
  }

  async getAuditEvents() {
    return cloneAuditEvents(this.auditEvents);
  }

  async createTemporaryVisitor(input: CreateTemporaryVisitorInput) {
    let suffix = String(Math.floor(1000 + Math.random() * 9000));
    while (this.people.some((person) => person.id === `vis-temp-${suffix}`)) {
      suffix = String(Math.floor(1000 + Math.random() * 9000));
    }

    const barcode = input.barcode.trim().toUpperCase();
    if (
      this.people.some((person) => person.barcode.toUpperCase() === barcode) ||
      this.hardwareAssets.some((asset) => asset.barcode.toUpperCase() === barcode)
    ) {
      throw new Error(`Barcode ${barcode} is already assigned.`);
    }

    const hours = Math.min(24, Math.max(1, input.hours));
    const now = new Date();
    const requestedStart = new Date(input.validFrom);
    const requestedEnd = new Date(input.validUntil);
    const start = Number.isNaN(requestedStart.getTime()) || requestedStart < now
      ? now
      : requestedStart;
    const maximumEnd = start.getTime() + 24 * 60 * 60 * 1000;
    const fallbackEnd = start.getTime() + hours * 60 * 60 * 1000;
    const requestedEndTime = requestedEnd.getTime();
    const end = new Date(
      Number.isNaN(requestedEndTime) || requestedEndTime <= start.getTime()
        ? fallbackEnd
        : Math.min(requestedEndTime, maximumEnd)
    );
    const visitor: Person = {
      id: `vis-temp-${suffix}`,
      name: input.name.trim() || `Temporary Visitor ${suffix}`,
      type: "visitor",
      barcode,
      company: input.company.trim() || "Walk-in",
      phone: "+91 00000 00000",
      accessLevel: "Visitor",
      allowedZones: ["Main Entrance"],
      status: "pending_approval",
      host: input.host.trim() || "Security Desk",
      purpose: input.reason.trim() || "Temporary visit",
      validFrom: start.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }),
      validTo: end.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }),
      inside: false,
    };

    this.people = [visitor, ...this.people];
    const request: PermissionRequest = {
      id: `REQ-VIS-${suffix}`,
      type: "visitor",
      subjectId: visitor.id,
      subjectName: visitor.name,
      requester: visitor.host ?? "Security Desk",
      purpose: visitor.purpose ?? "Temporary visit",
      requestedZones: [...visitor.allowedZones],
      validFrom: visitor.validFrom ?? "",
      validTo: visitor.validTo ?? "",
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    const permission: AccessPermission = {
      id: `perm-${visitor.id}`,
      subjectId: visitor.id,
      subjectName: visitor.name,
      subjectType: "visitor",
      assignment: "Visitor access",
      state: "pending_approval",
      zones: [...visitor.allowedZones],
      validFrom: visitor.validFrom ?? "",
      validTo: visitor.validTo ?? "",
      source: "request",
      reason: "Awaiting permission manager approval",
      updatedAt: new Date().toISOString(),
      updatedBy: "Security Terminal",
    };
    const notification: PermissionNotification = {
      id: `NOT-${Date.now()}`,
      title: "Visitor approval requested",
      message: `${visitor.name} was created at the security terminal and needs access approval.`,
      category: "approval_request",
      priority: "high",
      relatedId: request.id,
      href: `/admin/permissions?request=${request.id}`,
      createdAt: new Date().toISOString(),
      read: false,
    };
    this.permissionRequests = [request, ...this.permissionRequests];
    this.permissions = [permission, ...this.permissions];
    this.notifications = [notification, ...this.notifications];
    return clonePeople([visitor])[0];
  }

  async createEmployee(input: CreateEmployeeInput) {
    const barcode = input.barcode.trim().toUpperCase();
    if (
      this.people.some((person) => person.barcode.toUpperCase() === barcode) ||
      this.hardwareAssets.some((asset) => asset.barcode.toUpperCase() === barcode)
    ) {
      throw new Error(`Barcode ${barcode} is already assigned.`);
    }

    let sequence = this.people.filter((person) => person.type === "employee").length + 1;
    while (this.people.some((person) => person.id === `emp-${String(sequence).padStart(3, "0")}`)) {
      sequence += 1;
    }

    const employee: Person = {
      id: `emp-${String(sequence).padStart(3, "0")}`,
      name: input.name.trim(),
      type: "employee",
      barcode,
      department: input.department.trim(),
      phone: "Not provided",
      accessLevel: input.accessLevel,
      allowedZones: [input.allowedZone],
      status: "active",
      inside: false,
    };

    this.people = [employee, ...this.people];
    this.permissions = [{
      id: `perm-${employee.id}`,
      subjectId: employee.id,
      subjectName: employee.name,
      subjectType: "employee",
      assignment: `${employee.department} employee`,
      state: "active",
      zones: [...employee.allowedZones],
      validFrom: "Today",
      validTo: "No expiry",
      source: "policy",
      updatedAt: new Date().toISOString(),
      updatedBy: "Admin User",
    }, ...this.permissions];
    return clonePeople([employee])[0];
  }

  async createHardwareAsset(input: CreateHardwareAssetInput) {
    const barcode = input.barcode.trim().toUpperCase();
    if (
      this.hardwareAssets.some((asset) => asset.barcode.toUpperCase() === barcode) ||
      this.people.some((person) => person.barcode.toUpperCase() === barcode)
    ) {
      throw new Error(`Barcode ${barcode} is already assigned.`);
    }

    let sequence = this.hardwareAssets.length + 1;
    while (this.hardwareAssets.some((asset) => asset.id === `hw-${String(sequence).padStart(3, "0")}`)) {
      sequence += 1;
    }

    const assignedEmployee = this.people.find(
      (person) => person.type === "employee" && person.name.toLowerCase() === input.owner.trim().toLowerCase()
    );
    const asset: HardwareAsset = {
      id: `hw-${String(sequence).padStart(3, "0")}`,
      name: input.name.trim(),
      barcode,
      owner: input.owner.trim(),
      assignedEmployeeId: assignedEmployee?.id,
      assignedEmployeeName: assignedEmployee?.name,
      category: input.category.trim(),
      allowedZones: [input.allowedZone],
      status: input.status,
      inside: false,
    };

    this.hardwareAssets = [asset, ...this.hardwareAssets];
    this.permissions = [{
      id: `perm-${asset.id}`,
      subjectId: asset.id,
      subjectName: asset.name,
      subjectType: "hardware",
      assignment: assignedEmployee ? `Assigned to ${assignedEmployee.name}` : asset.owner,
      state: asset.status === "restricted" ? "restricted" : "active",
      zones: [...asset.allowedZones],
      validFrom: "Today",
      validTo: "No expiry",
      source: "policy",
      updatedAt: new Date().toISOString(),
      updatedBy: "Asset Manager",
    }, ...this.permissions];
    return cloneHardware([asset])[0];
  }

  async updatePerson(personId: string, patch: Partial<Omit<Person, "id">>) {
    const existing = this.people.find((person) => person.id === personId);
    if (!existing) throw new Error(`Person ${personId} was not found.`);
    const updated = { ...existing, ...patch, id: existing.id };
    this.people = this.people.map((person) => (person.id === personId ? updated : person));
    return clonePeople([updated])[0];
  }

  async updateHardwareAsset(
    assetId: string,
    patch: Partial<Omit<HardwareAsset, "id">>
  ) {
    const existing = this.hardwareAssets.find((asset) => asset.id === assetId);
    if (!existing) throw new Error(`Hardware asset ${assetId} was not found.`);
    const updated = { ...existing, ...patch, id: existing.id };
    this.hardwareAssets = this.hardwareAssets.map((asset) =>
      asset.id === assetId ? updated : asset
    );
    return cloneHardware([updated])[0];
  }

  async updateAlert(alertId: string, patch: Partial<Omit<Alert, "id">>) {
    const existing = this.alerts.find((alert) => alert.id === alertId);
    if (!existing) throw new Error(`Alert ${alertId} was not found.`);
    const updated = { ...existing, ...patch, id: existing.id };
    this.alerts = this.alerts.map((alert) => (alert.id === alertId ? updated : alert));
    return { ...updated };
  }

  async updateAccessPermission(input: UpdateAccessPermissionInput) {
    const existing = this.permissions.find(
      (permission) => permission.subjectId === input.subjectId
    );
    if (!existing) throw new Error(`Permission for ${input.subjectId} was not found.`);

    const now = new Date();
    const updated: AccessPermission = {
      ...existing,
      state: input.state,
      zones: input.zones?.length ? [...input.zones] : [...existing.zones],
      validFrom: input.validFrom || existing.validFrom,
      validTo: input.validTo || existing.validTo,
      source: "manual",
      reason: input.reason,
      updatedAt: now.toISOString(),
      updatedBy: "Admin User",
    };
    this.permissions = this.permissions.map((permission) =>
      permission.id === existing.id ? updated : permission
    );

    const person = this.people.find((item) => item.id === input.subjectId);
    if (person) {
      const status: Person["status"] =
        input.state === "active"
          ? person.type === "visitor"
            ? "pre_approved"
            : "active"
          : input.state === "restricted"
            ? "restricted"
            : input.state === "expired"
              ? "expired"
              : input.state === "pending_approval"
                ? "pending_approval"
                : "inactive";
      this.people = this.people.map((item) =>
        item.id === person.id
          ? { ...item, status, allowedZones: [...updated.zones] }
          : item
      );
    }

    const hardware = this.hardwareAssets.find((item) => item.id === input.subjectId);
    if (hardware) {
      this.hardwareAssets = this.hardwareAssets.map((item) =>
        item.id === hardware.id
          ? {
              ...item,
              status: input.state === "restricted" || input.state === "revoked" ? "restricted" : "active",
              allowedZones: [...updated.zones],
            }
          : item
      );
    }

    const granted = input.state === "active";
    const audit: AuditEvent = {
      id: `AUD-${Date.now()}`,
      category: "permission",
      action: granted ? "Manual permission granted" : "Manual permission denied",
      subjectId: updated.subjectId,
      subjectName: updated.subjectName,
      actor: "Admin User",
      role: "Administrator",
      decision: granted ? "granted" : "denied",
      reason: input.reason,
      relatedId: updated.id,
      date: facilityDate(now),
      time: facilityTime(now),
      createdAt: now.toISOString(),
    };
    this.auditEvents = [audit, ...this.auditEvents];
    this.notifications = [{
      id: `NOT-${Date.now()}`,
      title: granted ? "Permission granted" : "Permission changed",
      message: `${updated.subjectName}: ${input.reason}`,
      category: "permission_change",
      priority: granted ? "normal" : "high",
      relatedId: updated.id,
      href: `/admin/permissions?subject=${updated.subjectId}`,
      createdAt: now.toISOString(),
      read: false,
    }, ...this.notifications];
    return clonePermissions([updated])[0];
  }

  async decidePermissionRequest(
    requestId: string,
    decision: "approved" | "denied",
    reason: string
  ) {
    const existing = this.permissionRequests.find((request) => request.id === requestId);
    if (!existing) throw new Error(`Permission request ${requestId} was not found.`);
    if (existing.status !== "pending") return clonePermissionRequests([existing])[0];

    const now = new Date();
    const updated: PermissionRequest = { ...existing, status: decision };
    this.permissionRequests = this.permissionRequests.map((request) =>
      request.id === requestId ? updated : request
    );

    if (existing.type === "visitor") {
      this.people = this.people.map((person) =>
        person.id === existing.subjectId
          ? { ...person, status: decision === "approved" ? "pre_approved" : "inactive" }
          : person
      );
    }

    if (existing.type === "hardware_custody" && decision === "approved" && existing.hardwareId) {
      this.hardwareAssets = this.hardwareAssets.map((asset) =>
        asset.id === existing.hardwareId
          ? {
              ...asset,
              assignedEmployeeId: existing.carrierId,
              assignedEmployeeName: existing.carrierName,
            }
          : asset
      );
    }

    const permission = this.permissions.find(
      (item) => item.subjectId === existing.subjectId
    );
    if (permission) {
      this.permissions = this.permissions.map((item) =>
        item.id === permission.id
          ? {
              ...item,
              state: decision === "approved" ? "active" : "revoked",
              assignment:
                existing.type === "hardware_custody" && decision === "approved"
                  ? `Assigned to ${existing.carrierName ?? existing.requester}`
                  : item.assignment,
              source: "request",
              reason,
              updatedAt: now.toISOString(),
              updatedBy: "Admin User",
            }
          : item
      );
    }

    this.auditEvents = [{
      id: `AUD-${Date.now()}`,
      category: "permission",
      action: `${existing.type === "visitor" ? "Visitor" : "Hardware custody"} request ${decision}`,
      subjectId: existing.subjectId,
      subjectName: existing.subjectName,
      actor: "Admin User",
      role: "Administrator",
      decision: decision === "approved" ? "granted" : "denied",
      reason,
      relatedId: requestId,
      date: facilityDate(now),
      time: facilityTime(now),
      createdAt: now.toISOString(),
    }, ...this.auditEvents];
    this.notifications = [{
      id: `NOT-${Date.now()}`,
      title: `Request ${decision}`,
      message: `${existing.subjectName}: ${reason}`,
      category: "permission_change",
      priority: decision === "denied" ? "high" : "normal",
      relatedId: requestId,
      href: `/admin/permissions?request=${requestId}`,
      createdAt: now.toISOString(),
      read: false,
    }, ...this.notifications];
    return clonePermissionRequests([updated])[0];
  }

  async updateAlertRule(ruleId: string, enabled: boolean) {
    const existing = this.alertRules.find((rule) => rule.id === ruleId);
    if (!existing) throw new Error(`Alert rule ${ruleId} was not found.`);
    const updated = { ...existing, enabled };
    this.alertRules = this.alertRules.map((rule) => (rule.id === ruleId ? updated : rule));
    return { ...updated };
  }

  async markNotificationRead(notificationId: string) {
    const existing = this.notifications.find((notification) => notification.id === notificationId);
    if (!existing) throw new Error(`Notification ${notificationId} was not found.`);
    const updated = { ...existing, read: true };
    this.notifications = this.notifications.map((notification) =>
      notification.id === notificationId ? updated : notification
    );
    return { ...updated };
  }

  async recordScan(input: RecordScanInput): Promise<RecordScanResult> {
    const checkpoint = this.checkpoints.find((item) => item.id === input.checkpointId);
    if (!checkpoint) throw new Error(`Checkpoint ${input.checkpointId} was not found.`);

    const decision = evaluateScan({
      barcode: input.barcode,
      checkpoint,
      people: this.people,
      hardware: this.hardwareAssets,
      selectedHardwareIds: input.selectedHardwareIds,
      online: input.online,
      eventCount: this.movements.length + 1,
      scanType: input.scanType,
    });
    const nextState = applyMovementState(
      decision.event,
      this.people,
      this.hardwareAssets
    );

    this.people = nextState.people;
    this.hardwareAssets = nextState.hardware;
    this.movements = [decision.event, ...this.movements];

    const generatedAlert = createScanAlert({
      event: decision.event,
      subject: decision.subject,
      carriedHardware: decision.carriedHardware,
      rules: this.alertRules,
      existingAlerts: this.alerts,
    });
    if (generatedAlert) {
      this.alerts = [generatedAlert, ...this.alerts];
      this.auditEvents = [{
        id: `AUD-${Date.now()}`,
        category: "alert",
        action: "Automated alert raised",
        subjectId: decision.event.subjectId,
        subjectName: decision.event.subjectName,
        actor: "Rule Engine",
        role: "System",
        reason: generatedAlert.reason,
        relatedId: generatedAlert.id,
        date: generatedAlert.date,
        time: generatedAlert.time,
        createdAt: new Date().toISOString(),
      }, ...this.auditEvents];
    }

    const carrier = decision.subject && "type" in decision.subject ? decision.subject : undefined;
    const custodyAsset = decision.carriedHardware.find(
      (asset) =>
        carrier &&
        asset.assignedEmployeeId &&
        asset.assignedEmployeeId !== carrier.id
    );
    if (carrier && custodyAsset && decision.event.reason?.startsWith("Hardware assigned to")) {
      const duplicate = this.permissionRequests.some(
        (request) =>
          request.type === "hardware_custody" &&
          request.hardwareId === custodyAsset.id &&
          request.carrierId === carrier.id &&
          request.status === "pending"
      );
      if (!duplicate) {
        const request: PermissionRequest = {
          id: `REQ-HW-${Date.now()}`,
          type: "hardware_custody",
          subjectId: custodyAsset.id,
          subjectName: custodyAsset.name,
          requester: carrier.name,
          purpose: `Custody exception requested at ${decision.event.checkpoint}`,
          requestedZones: [...custodyAsset.allowedZones],
          validFrom: `${decision.event.date} ${decision.event.time}`,
          validTo: "End of day",
          status: "pending",
          createdAt: new Date().toISOString(),
          hardwareId: custodyAsset.id,
          carrierId: carrier.id,
          carrierName: carrier.name,
        };
        this.permissionRequests = [request, ...this.permissionRequests];
        this.notifications = [{
          id: `NOT-${Date.now()}`,
          title: "Hardware custody approval requested",
          message: `${carrier.name} attempted to move ${custodyAsset.name}, assigned to ${custodyAsset.assignedEmployeeName}.`,
          category: "approval_request",
          priority: "high",
          relatedId: request.id,
          href: `/admin/permissions?request=${request.id}`,
          createdAt: new Date().toISOString(),
          read: false,
        }, ...this.notifications];
      }
    }

    const scheduledAlerts = evaluateScheduledRules({
      rules: this.alertRules,
      movements: this.movements,
      workdays: initialWorkdayStatuses,
      existingAlerts: this.alerts,
    });
    if (scheduledAlerts.length) {
      this.alerts = [...scheduledAlerts, ...this.alerts];
    }

    return {
      decision: {
        ...decision,
        event: { ...decision.event, hardwareIds: [...decision.event.hardwareIds] },
        carriedHardware: cloneHardware(decision.carriedHardware),
      },
      people: clonePeople(this.people),
      hardwareAssets: cloneHardware(this.hardwareAssets),
    };
  }

  async saveMovement(event: MovementEvent) {
    const saved = { ...event, hardwareIds: [...event.hardwareIds] };
    const exists = this.movements.some((movement) => movement.id === event.id);
    this.movements = exists
      ? this.movements.map((movement) => (movement.id === event.id ? saved : movement))
      : [saved, ...this.movements];
    return { ...saved, hardwareIds: [...saved.hardwareIds] };
  }

  async syncMovements(eventIds?: string[]) {
    const selected = eventIds ? new Set(eventIds) : null;
    this.movements = this.movements.map((event) => {
      const shouldSync =
        event.syncState === "queued" && (!selected || selected.has(event.id));
      if (!shouldSync) return event;
      return {
        ...event,
        syncState: event.result === "approved" ? "synced" : "conflict",
      };
    });
    return cloneMovements(this.movements);
  }

  async resolveMovementConflicts(eventIds: string[]) {
    const selected = new Set(eventIds);
    this.movements = this.movements.map((event) =>
      event.syncState === "conflict" && selected.has(event.id)
        ? { ...event, syncState: "synced" }
        : event
    );
    return cloneMovements(this.movements);
  }

  async addMovementNote(eventId: string, note: string) {
    const trimmed = note.trim();
    if (!trimmed) return [...(this.movementNotes[eventId] ?? [])];
    const notes = [...(this.movementNotes[eventId] ?? []), trimmed];
    this.movementNotes = { ...this.movementNotes, [eventId]: notes };
    return [...notes];
  }
}
