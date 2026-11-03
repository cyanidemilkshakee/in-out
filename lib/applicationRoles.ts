export const MASTER_ADMIN_ROLE = "master-admin";
export const ZONE_ADMIN_ROLE = "zone-admin";

export function hasAdminAccess(roles: unknown): boolean {
  return Array.isArray(roles) && (roles.includes(ZONE_ADMIN_ROLE) || roles.includes(MASTER_ADMIN_ROLE));
}

export function hasMasterAdminAccess(roles: unknown): boolean {
  return Array.isArray(roles) && roles.includes(MASTER_ADMIN_ROLE);
}
