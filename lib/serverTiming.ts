import { AsyncLocalStorage } from "node:async_hooks";

/** Request-local measurements. Names are fixed stages, never URLs or user data. */
export class ServerTiming {
  private readonly startedAt: number;
  private readonly timings: Record<string, number> = {};
  private authenticationRecorded = false;
  private readonly activeSpans = new Map<string, { count: number; startedAt: number }>();

  constructor(private readonly now: () => number = () => performance.now()) {
    this.startedAt = this.now();
  }

  add(name: string, milliseconds: number) {
    if (!/^[a-z][a-z_]*$/.test(name) || name === "total" || !Number.isFinite(milliseconds) || milliseconds < 0) return;
    this.timings[name] = (this.timings[name] ?? 0) + milliseconds;
  }

  authenticated() {
    if (this.authenticationRecorded) return;
    this.authenticationRecorded = true;
    this.add("auth", this.now() - this.startedAt);
  }

  /** Keep cumulative work and overlapping wall time separately. */
  begin(name: string): () => void {
    if (!/^[a-z][a-z_]*$/.test(name) || name === "total") return () => {};
    const startedAt = this.now();
    const span = this.activeSpans.get(name) ?? { count: 0, startedAt };
    span.count++;
    this.activeSpans.set(name, span);
    let completed = false;
    return () => {
      if (completed) return;
      completed = true;
      const endedAt = this.now();
      this.add(name, endedAt - startedAt);
      if (--span.count === 0) {
        this.add(`${name}_wall`, endedAt - span.startedAt);
        this.activeSpans.delete(name);
      }
    };
  }

  measure<T>(name: string, work: () => T): T {
    const startedAt = this.now();
    try { return work(); }
    finally { this.add(name, this.now() - startedAt); }
  }

  header() {
    return [...Object.entries(this.timings), ["total", this.now() - this.startedAt] as const]
      .map(([name, milliseconds]) => `${name};dur=${milliseconds.toFixed(2)}`)
      .join(", ");
  }
}

const requestTimings = new AsyncLocalStorage<ServerTiming>();

export function currentServerTiming() {
  return requestTimings.getStore();
}

export function withServerTiming<T>(timing: ServerTiming, work: () => T): T {
  return requestTimings.run(timing, work);
}
