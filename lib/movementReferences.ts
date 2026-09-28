/** Recognize complete IDs produced by scans, manual approvals, and legacy seeds. */
export function isMovementEventId(value: string): boolean {
  return /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|MAN-[0-9a-f]{32}|EVT-\d{6,})$/i.test(value.trim());
}

export function movementLogHref(eventId: string): string {
  return `/admin/logs?${new URLSearchParams({ eventId }).toString()}`;
}
