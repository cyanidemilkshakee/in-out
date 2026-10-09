export type ManagedUser = {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  enabled: boolean;
  emailVerified: boolean;
  createdTimestamp?: number;
  roles?: Array<"admin" | "operator">;
  checkpointId?: "cp-main" | "server-room" | null;
};

async function request<T>(method: "GET" | "POST", body?: unknown, query?: string): Promise<T> {
  const response = await fetch(`/api/keycloak${query ? `?${query}` : ""}`, {
    method,
    headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null) as { data?: T; error?: string } | null;
  if (!response.ok || !payload?.data) throw new Error(payload?.error ?? "Identity request failed.");
  return payload.data;
}

export function listManagedUsers(search = "") {
  return request<{ items: ManagedUser[] }>("GET", undefined, `search=${encodeURIComponent(search)}&max=100`);
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

export function setManagedUserRoles(userId: string, roles: string[]) {
  return request<{ roles: string[] }>("POST", { action: "setRoles", userId, input: { roles } });
}

export function resetManagedUserPassword(userId: string, password: string, temporary: boolean) {
  return request<{ updated: boolean }>("POST", { action: "resetPassword", userId, input: { password, temporary } });
}

export function endManagedUserSessions(userId: string) {
  return request<{ ended: boolean }>("POST", { action: "endSessions", userId });
}
