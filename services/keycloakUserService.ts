export type ManagedUser = {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  enabled: boolean;
  emailVerified: boolean;
  createdTimestamp?: number;
  roles?: Array<"zone-admin" | "operator" | "master-admin">;
  checkpointId?: string | null;
  zoneIds?: string[];
  inviteStatus?: "pending" | "expired" | "accepted" | "revoked" | null;
  inviteExpiresAt?: number | null;
  canManage: boolean;
};

async function request<T>(method: "GET" | "POST", body?: unknown, query?: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/keycloak${query ? `?${query}` : ""}`, {
    method,
    headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal,
  });
  const payload = await response.json().catch(() => null) as { data?: T; error?: string } | null;
  if (!response.ok || !payload?.data) throw new Error(payload?.error ?? "Identity request failed.");
  return payload.data;
}

export type ManagedUserPage = { items: ManagedUser[]; first: number; max: number; hasMore: boolean; nextFirst: number | null };
export type PendingSsoUser = ManagedUser & { provider: "zoho" };
export type PendingSsoUserPage = { items: PendingSsoUser[]; first: number; max: number; hasMore: boolean; nextFirst: number | null };
export type SsoApprovalInput = {
  roles: Array<"zone-admin" | "operator">;
  checkpointId?: string | null;
  zoneIds?: string[];
};
export const MANAGED_USER_PAGE_SIZE = 25;

async function invitationRequest<T>(body: unknown): Promise<T> {
  const response = await fetch("/api/invitations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null) as { data?: T; error?: string } | null;
  if (!response.ok || payload?.data === undefined) throw new Error(payload?.error ?? "Invitation request failed.");
  return payload.data;
}

export async function listManagedUserPage(search = "", first = 0, signal?: AbortSignal): Promise<ManagedUserPage> {
  const page = await request<ManagedUserPage>("GET", undefined,
    `search=${encodeURIComponent(search.trim())}&first=${first}&max=${MANAGED_USER_PAGE_SIZE}`, signal);
  if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean" || (page.hasMore && (!Number.isSafeInteger(page.nextFirst) || page.nextFirst! <= first))) {
    throw new Error("Identity service returned an invalid directory page.");
  }
  return page;
}

export async function listManagedUsers(search = "", signal?: AbortSignal): Promise<{ items: ManagedUser[] }> {
  const items = new Map<string, ManagedUser>();
  const pageSize = 100;
  for (let first = 0; ; first += pageSize) {
    const page = await request<{ items: ManagedUser[] }>("GET", undefined,
      `search=${encodeURIComponent(search.trim())}&first=${first}&max=${pageSize}`, signal);
    if (!Array.isArray(page.items)) throw new Error("Identity service returned an invalid user directory.");
    const previousSize = items.size;
    for (const user of page.items) items.set(user.id, user);
    if (page.items.length < pageSize) return { items: [...items.values()] };
    if (items.size === previousSize) throw new Error("Unable to load the complete user directory. Please search again.");
  }
}

export async function listPendingZohoSsoUsers(search = "", first = 0, signal?: AbortSignal): Promise<PendingSsoUserPage> {
  const page = await request<PendingSsoUserPage>("GET", undefined,
    `pendingSso=zoho&search=${encodeURIComponent(search.trim())}&first=${first}&max=${MANAGED_USER_PAGE_SIZE}`, signal);
  if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean" ||
      (page.hasMore && (!Number.isSafeInteger(page.nextFirst) || page.nextFirst! <= first))) {
    throw new Error("Identity service returned an invalid pending SSO page.");
  }
  return page;
}

export function approveZohoSsoUser(userId: string, input: SsoApprovalInput) {
  return request<ManagedUser>("POST", { action: "approveSsoUser", userId, input });
}

export function getManagedUser(userId: string) {
  return request<ManagedUser>("GET", undefined, `userId=${encodeURIComponent(userId)}`);
}

export function createManagedUser(input: Record<string, unknown>) {
  const { email, firstName, lastName, roles, checkpointId, zoneIds } = input;
  const roleList = Array.isArray(roles) ? roles : [];
  const role = roleList.includes("zone-admin") ? "zone-admin" : "operator";
  return invitationRequest<ManagedUser>({ action: "create",
    email, firstName, lastName, role, checkpointId: role === "operator" ? checkpointId : null,
    zoneIds: role === "zone-admin" && Array.isArray(zoneIds) ? zoneIds : [],
  });
}

export function resendManagedUserInvite(userId: string) {
  return invitationRequest<ManagedUser>({ action: "resend", userId });
}

export function revokeManagedUserInvite(userId: string) {
  return invitationRequest<{ revoked: boolean }>({ action: "revoke", userId });
}

export function updateManagedUser(userId: string, input: Record<string, unknown>) {
  return request<ManagedUser>("POST", { action: "updateUser", userId, input });
}

export function resetManagedUserPassword(userId: string, password: string, temporary: boolean) {
  return request<{ updated: boolean }>("POST", { action: "resetPassword", userId, input: { password, temporary } });
}

export function endManagedUserSessions(userId: string) {
  return request<{ ended: boolean }>("POST", { action: "endSessions", userId });
}

export function deleteManagedUser(userId: string) {
  return request<{ deleted: boolean }>("POST", { action: "deleteUser", userId });
}
