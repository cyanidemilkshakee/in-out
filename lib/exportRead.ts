import { CollectionByteBudget } from "./boundedCollection";

export function assertCsvBound(content: string) {
  if (new Blob([content]).size > 16 * 1024 * 1024) throw new Error("The CSV exceeds the 16 MiB export limit. Narrow the filters.");
}

/** One admitted consistent backend read; formatting stays identical to the UI. */
export async function readExport<T>(source: "registry" | "movements" | "alerts" | "permissions",
  query: Record<string, string | number | undefined> = {}, signal?: AbortSignal): Promise<T> {
  const params = new URLSearchParams({ resource: "export", source });
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
  const response = await fetch(`/api/data?${params}`, { signal, cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Unable to read the complete export.");
  if (!body || !("data" in body)) throw new Error("Invalid export response.");
  new CollectionByteBudget().charge(body.data);
  return body.data as T;
}
