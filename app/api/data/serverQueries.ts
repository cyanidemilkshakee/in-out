import { callPythonApi } from "../pythonApi";

const ALERT_PAGE_SIZE = 500;
const EMPLOYEE_PAGE_SIZE = 200;

/** Load review/history records and current per-subject rule assignments. */
export async function loadAllAlerts() {
  const [first, assignments, firstEmployees] = await Promise.all([
    callPythonApi(`/v1/alerts?limit=${ALERT_PAGE_SIZE}&offset=0`, "GET"),
    callPythonApi("/v1/alert-rule-assignments", "GET"),
    callPythonApi(`/v1/registry/subjects?kind=employee&limit=${EMPLOYEE_PAGE_SIZE}&offset=0`, "GET"),
  ]);
  const items = Array.isArray(first.items) ? [...first.items] : [];
  const total = Number(first.total) || 0;
  let offset = items.length;

  while (offset < total) {
    const page = await callPythonApi(
      `/v1/alerts?limit=${ALERT_PAGE_SIZE}&offset=${offset}`,
      "GET"
    );
    const nextItems = Array.isArray(page.items) ? page.items : [];
    if (!nextItems.length) break;
    items.push(...nextItems);
    offset += nextItems.length;
  }

  const employeeSubjects = Array.isArray(firstEmployees.items) ? [...firstEmployees.items] : [];
  const employeeTotal = Number(firstEmployees.total) || 0;
  let employeeOffset = employeeSubjects.length;
  while (employeeOffset < employeeTotal) {
    const page = await callPythonApi(
      `/v1/registry/subjects?kind=employee&limit=${EMPLOYEE_PAGE_SIZE}&offset=${employeeOffset}`,
      "GET"
    );
    const nextEmployees = Array.isArray(page.items) ? page.items : [];
    if (!nextEmployees.length) break;
    employeeSubjects.push(...nextEmployees);
    employeeOffset += nextEmployees.length;
  }

  const people = employeeSubjects.map((raw) => {
    const subject = raw as { id?: unknown; barcode?: unknown; data?: unknown };
    const data = subject.data && typeof subject.data === "object"
      ? subject.data as Record<string, unknown>
      : {};
    return {
      ...data,
      id: String(subject.id ?? ""),
      barcode: String(subject.barcode ?? data.barcode ?? ""),
      type: "employee",
      status: typeof data.status === "string" ? data.status : "active",
      allowedZones: Array.isArray(data.allowedZones) ? data.allowedZones : [],
      inside: Boolean(data.inside),
    };
  });

  const recentTriggers = new Map((first.rules ?? []).map((rule: { id: string; recentTriggers?: number }) => [rule.id, rule.recentTriggers ?? 0]));
  return { ...first, items, total: items.length, assignments: assignments.subjects ?? [],
    people,
    rules: (assignments.rules ?? []).map((rule: { id: string }) => ({ ...rule, recentTriggers: recentTriggers.get(rule.id) ?? 0 })) };
}
