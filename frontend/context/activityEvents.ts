export function refreshOpenAlertCount() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("inout:alerts-changed"));
}
