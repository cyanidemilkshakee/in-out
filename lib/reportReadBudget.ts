import { CollectionByteBudget } from "./boundedCollection";

type ReportPage<T> = { items: T[]; total: number; pageSize?: number };

/** Bound a report's paged reads by record count, response size, and elapsed time. */
export class ReportReadBudget {
  private readonly controller = new AbortController();
  private readonly bytes: CollectionByteBudget;
  private readonly timer: ReturnType<typeof setTimeout>;
  private reservedRows = 0;

  constructor(private readonly maximumRows = 10_000, maximumBytes = 16 * 1024 * 1024,
    timeoutMs = 60_000, private readonly maximumPageSize = 200) {
    this.bytes = new CollectionByteBudget(maximumBytes);
    this.timer = setTimeout(() => this.abort(new Error("Report loading timed out. Choose a shorter date range and try again.")), timeoutMs);
  }

  abort(reason: unknown) { this.controller.abort(reason); }
  dispose() { clearTimeout(this.timer); }

  private async waitFor<T>(load: () => Promise<T>): Promise<T> {
    this.controller.signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const stop = () => reject(this.controller.signal.reason);
      this.controller.signal.addEventListener("abort", stop, { once: true });
      load().then(resolve, reject).finally(() => this.controller.signal.removeEventListener("abort", stop));
    });
  }

  async load<T>(fetchPage: (page: number) => Promise<ReportPage<T>>): Promise<T[]> {
    try {
      const first = await this.waitFor(() => fetchPage(1));
      if (!Number.isSafeInteger(first.total) || first.total < 0) throw new Error("Backend returned an invalid report total.");
      this.reservedRows += first.total;
      if (this.reservedRows > this.maximumRows) throw new Error(`A report can contain up to ${this.maximumRows.toLocaleString("en-US")} records. Choose a shorter date range.`);
      const pageSize = first.pageSize ?? this.maximumPageSize;
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > this.maximumPageSize) throw new Error("Backend returned an invalid report page size.");
      const pageCount = Math.ceil(first.total / pageSize);
      const items: T[] = [];
      const seen = new Set<string>();
      const append = (page: ReportPage<T>) => {
        this.controller.signal.throwIfAborted();
        this.bytes.charge(page);
        if (page.total !== first.total || !Array.isArray(page.items) || (!page.items.length && items.length < first.total)) {
          throw new Error("Report records changed while loading. Generate the report again.");
        }
        for (const item of page.items) {
          const id = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
          if (typeof id !== "string" || !id || seen.has(id) || items.length >= first.total) {
            throw new Error("Report records changed while loading. Generate the report again.");
          }
          seen.add(id);
          items.push(item);
        }
      };
      append(first);
      for (let page = 2; page <= pageCount; page += 1) append(await this.waitFor(() => fetchPage(page)));
      if (items.length !== first.total) throw new Error("The complete report could not be loaded. Generate the report again.");
      return items;
    } catch (error) {
      this.abort(error);
      throw error;
    }
  }
}
