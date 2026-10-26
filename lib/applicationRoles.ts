export const MASTER_ADMIN_ROLE = "master-admin";

export function hasAdminAccess(roles: unknown): boolean {
  return Array.isArray(roles) && (roles.includes("admin") || roles.includes(MASTER_ADMIN_ROLE));
}

export function hasMasterAdminAccess(roles: unknown): boolean {
  return Array.isArray(roles) && roles.includes(MASTER_ADMIN_ROLE);
}
