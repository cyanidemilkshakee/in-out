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
