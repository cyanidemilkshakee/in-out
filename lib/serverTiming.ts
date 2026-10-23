import { AsyncLocalStorage } from "node:async_hooks";

/** Request-local measurements. Names are fixed stages, never URLs or user data. */
export class ServerTiming {
  private readonly startedAt = performance.now();
  private readonly timings: Record<string, number> = {};
  private authenticationRecorded = false;

  add(name: string, milliseconds: number) {
    if (!/^[a-z][a-z_]*$/.test(name) || name === "total" || !Number.isFinite(milliseconds) || milliseconds < 0) return;
    this.timings[name] = (this.timings[name] ?? 0) + milliseconds;
  }

  authenticated() {
    if (this.authenticationRecorded) return;
    this.authenticationRecorded = true;
    this.add("auth", performance.now() - this.startedAt);
  }

  measure<T>(name: string, work: () => T): T {
    const startedAt = performance.now();
    try { return work(); }
    finally { this.add(name, performance.now() - startedAt); }
  }

  header() {
    return [...Object.entries(this.timings), ["total", performance.now() - this.startedAt] as const]
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
