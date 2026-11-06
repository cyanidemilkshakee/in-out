/** Batch display-only invalidations without postponing refreshes indefinitely. */
export function createRefreshScheduler(refresh: () => void, quietMs = 200, maxWaitMs = 1_000) {
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    clearTimeout(quietTimer);
    clearTimeout(deadlineTimer);
    quietTimer = undefined;
    deadlineTimer = undefined;
  };
  const flush = () => {
    cancel();
    refresh();
  };

  return {
    request() {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(flush, quietMs);
      deadlineTimer ??= setTimeout(flush, maxWaitMs);
    },
    cancel,
  };
}

/** Let parallel display reads finish before reconciling one later live change. */
export function createReadRefreshGate(refresh: () => void) {
  let activeReads = 0;
  let pending = false;
  return {
    request() {
      if (activeReads) pending = true;
      else refresh();
    },
    begin() {
      activeReads++;
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        activeReads--;
        if (!activeReads && pending) {
          pending = false;
          refresh();
        }
      };
    },
    cancel() { pending = false; },
  };
}
