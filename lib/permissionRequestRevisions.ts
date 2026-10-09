import type { PermissionRequest } from "./types";

/** HTTP replies and live events can arrive in either order; decisions never reopen. */
export function mergePermissionRequests(current: PermissionRequest[], updates: PermissionRequest[]) {
  const previous = new Map(current.map(request => [request.id, request]));
  const incoming = new Map<string, PermissionRequest>();
  for (const update of updates) {
    const saved = incoming.get(update.id) ?? previous.get(update.id);
    if (saved && saved.status !== "pending" && update.status === "pending") continue;
    if (saved && saved.status !== "pending" && Date.parse(saved.decidedAt ?? "") > Date.parse(update.decidedAt ?? "")) continue;
    incoming.set(update.id, { ...update,
      ...(saved?.consumedAt && !update.consumedAt ? {
        consumedAt: saved.consumedAt,
        consumedMovementId: saved.consumedMovementId,
        consumedBy: saved.consumedBy,
      } : {}),
      ...(saved?.notificationDismissedAt && !update.notificationDismissedAt ? {
        notificationDismissedAt: saved.notificationDismissedAt,
        notificationDismissedBy: saved.notificationDismissedBy,
      } : {}),
    });
  }
  return [...incoming.values()].filter(request => !previous.has(request.id))
    .concat(current.map(request => incoming.get(request.id) ?? request));
}
