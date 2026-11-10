import type { Checkpoint, Person } from "./types";

/** Resolve an employee's effective active checkpoints for registry display. */
export function effectiveCheckpointLabels(person: Pick<Person, "allowedZones" | "allowedCheckpoints">, checkpoints: Checkpoint[]) {
  const explicitIds = [...new Set((person.allowedCheckpoints ?? []).filter(Boolean))];
  const checkpointIds = explicitIds.length
    ? explicitIds
    : checkpoints
      .filter((checkpoint) => person.allowedZones.includes("All Zones")
        || person.allowedZones.includes(checkpoint.zoneId ?? checkpoint.zone))
      .map((checkpoint) => checkpoint.id);
  const checkpointById = new Map(checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));

  return checkpointIds.map((id) => {
    const checkpoint = checkpointById.get(id);
    if (!checkpoint) return id;
    const name = checkpoint.name?.trim() || id;
    const gateLabel = checkpoint.gateLabel?.trim();
    return gateLabel && gateLabel.toLocaleLowerCase() !== name.toLocaleLowerCase()
      ? `${name} · ${gateLabel}`
      : name;
  });
}
