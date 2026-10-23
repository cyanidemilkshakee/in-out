export function hasAdminAccess(roles: unknown): boolean {
  return Array.isArray(roles) && roles.includes("admin");
}
