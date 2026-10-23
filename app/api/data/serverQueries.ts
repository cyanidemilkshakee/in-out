import { callPythonApi } from "../pythonApi";

/** First command-center page, aggregate counts and upcoming leave only.
 * History and person settings are fetched when the operator opens them.
 */
export async function loadAllAlerts(parentSignal?: AbortSignal) {
  return callPythonApi("/v1/alerts?view=command&limit=50&offset=0&sortDirection=asc", "GET",
    undefined, undefined, { signal: parentSignal });
}
