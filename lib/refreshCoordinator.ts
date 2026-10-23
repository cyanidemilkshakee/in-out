/** Coalesce view refreshes without reusing data after a write or stream gap. */
export function createRefreshCoordinator(refresh: () => Promise<void>) {
  let current: Promise<void> | undefined;
  let started = false;
  let pending = false;

  return {
    request(afterCurrent = false): Promise<void> {
      if (current) {
        // Focus and visibility events can share the active read. A write or
        // reconnect may have happened after that read began and needs another.
        if (afterCurrent && started) pending = true;
        return current;
      }
      current = Promise.resolve().then(async () => {
        try {
          do {
            pending = false;
            started = true;
            await refresh();
          } while (pending);
        } finally {
          current = undefined;
          started = false;
          pending = false;
        }
      });
      return current;
    },
    clearPending() {
      pending = false;
    },
  };
}
