import type { MovementEvent } from "./types";

/** Merge one scan's completed review into its existing chart row. */
export function mergeMovementRevisions(
  current: MovementEvent[],
  updates: MovementEvent[],
): MovementEvent[] {
  if (!updates.length) return current;
  const byId = new Map(current.map((movement) => [movement.id, movement]));
  const addedIds: string[] = [];
  for (const incoming of updates) {
    const previous = byId.get(incoming.id);
    if (previous && (
      (previous.manualReviewedAt && (!incoming.manualReviewedAt || incoming.manualReviewedAt < previous.manualReviewedAt)) ||
      (previous.result === "approved" && incoming.result === "denied")
    )) continue;
    if (!previous) addedIds.push(incoming.id);
    byId.set(incoming.id, incoming);
  }
  return [
    ...addedIds.map((id) => byId.get(id)!),
    ...current.map((movement) => byId.get(movement.id)!),
  ];
}
