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
export const MANAGED_USER_PAGE_SIZE = 25;

export async function listManagedUserPage(search = "", first = 0, signal?: AbortSignal): Promise<ManagedUserPage> {
  const page = await request<ManagedUserPage>("GET", undefined,
    `search=${encodeURIComponent(search.trim())}&first=${first}&max=${MANAGED_USER_PAGE_SIZE}`, signal);
  if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean" || (page.hasMore && (!Number.isSafeInteger(page.nextFirst) || page.nextFirst! <= first))) {
    throw new Error("Identity service returned an invalid directory page.");
  }
  return page;
}

export async function listManagedUsers(search = "") {
  const items = new Map<string, ManagedUser>();
  const pageSize = 100;
  for (let first = 0; ; first += pageSize) {
    const page = await request<{ items: ManagedUser[] }>("GET", undefined,
      `search=${encodeURIComponent(search.trim())}&first=${first}&max=${pageSize}`);
    if (!Array.isArray(page.items)) throw new Error("Identity service returned an invalid user directory.");
    const previousSize = items.size;
    for (const user of page.items) items.set(user.id, user);
    if (page.items.length < pageSize) return { items: [...items.values()] };
    // A provider ignoring its paging offset must fail visibly, not loop forever
    // or silently present the first page as the entire directory.
    if (items.size === previousSize) throw new Error("Unable to load the complete user directory. Please search again.");
  }
}

export function getManagedUser(userId: string) {
  return request<ManagedUser>("GET", undefined, `userId=${encodeURIComponent(userId)}`);
}

export function createManagedUser(input: Record<string, unknown>) {
  return request<ManagedUser>("POST", { action: "createUser", input });
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
