export class CollectionCapacityError extends Error {}

export class CollectionByteBudget {
  private used = 0;
  constructor(private readonly maximum = 16 * 1024 * 1024) {}
  charge(value: unknown) {
    this.used += new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (this.used > this.maximum) throw new CollectionCapacityError("This collection exceeds the bulk-load byte limit. Use a paginated view.");
  }
}

type Page = { items?: unknown[]; total?: unknown };

/** Reject incomplete or oversized bulk snapshots rather than silently truncate. */
export async function collectBoundedPages(
  first: Page,
  load: (offset: number) => Promise<Page>,
  budget: CollectionByteBudget,
  signal: AbortSignal,
  maximumRows = 10_000,
): Promise<unknown[]> {
  const total = Number(first.total);
  if (!Number.isSafeInteger(total) || total < 0 || total > maximumRows) {
    throw new CollectionCapacityError("This collection exceeds the bulk-load record limit. Use a paginated view.");
  }
  const items: unknown[] = [];
  const seen = new Set<string>();
  let page = first;
  while (true) {
    signal.throwIfAborted();
    if (Number(page.total) !== total || !Array.isArray(page.items) || (!page.items.length && items.length < total)) {
      throw new CollectionCapacityError("The collection changed while loading. Refresh the paginated view.");
    }
    for (const item of page.items) {
      const id = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
      if (typeof id !== "string" || !id || seen.has(id)) {
        throw new CollectionCapacityError("The collection changed while loading. Refresh the paginated view.");
      }
      seen.add(id);
      budget.charge(item);
      items.push(item);
      if (items.length > maximumRows || items.length > total) {
        throw new CollectionCapacityError("The collection changed while loading. Refresh the paginated view.");
      }
    }
    if (items.length === total) return items;
    page = await load(items.length);
  }
}
