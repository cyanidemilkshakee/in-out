export type TimingSink = (name: string, durationMs: number) => void;

function timingName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export class ServerTiming {
  private readonly durations = new Map<string, number>();

  add: TimingSink = (name, durationMs) => {
    const key = timingName(name);
    this.durations.set(key, (this.durations.get(key) ?? 0) + durationMs);
  };

  measure<T>(name: string, operation: () => T) {
    const startedAt = performance.now();
    try {
      return operation();
    } finally {
      this.add(name, performance.now() - startedAt);
    }
  }

  header() {
    return [...this.durations.entries()]
      .map(([name, duration]) => `${name};dur=${duration.toFixed(1)}`)
      .join(", ");
  }
}
