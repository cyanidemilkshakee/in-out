// Compound identity saves include provider reads, several writes, and bounded
// compensation requests. Ordinary profile/data calls keep the shorter budget.
export function identityCommandTimeoutMs(action: string): number {
  return ["createUser", "updateUser", "setRoles"].includes(action) ? 180_000 : 15_000;
}
