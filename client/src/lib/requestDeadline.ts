export class RequestTimeoutError extends Error {
  constructor() {
    super("The request took too long. Check your connection and try again.");
    this.name = "RequestTimeoutError";
  }
}

/** Bound the entire operation, including body reads; release listeners on exit. */
export async function withRequestDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal | readonly AbortSignal[],
): Promise<T> {
  const parents = parentSignal ? (Array.isArray(parentSignal) ? parentSignal : [parentSignal]) as readonly AbortSignal[] : [];
  const alreadyAborted = parents.find(signal => signal.aborted);
  if (alreadyAborted) throw alreadyAborted.reason;
  const controller = new AbortController();
  const cancel = () => controller.abort(parents.find(signal => signal.aborted)?.reason);
  parents.forEach(signal => signal.addEventListener("abort", cancel, { once: true }));
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new RequestTimeoutError()), timeoutMs);
  try {
    // Racing also settles callers when a transport/mock ignores cancellation.
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    parents.forEach(signal => signal.removeEventListener("abort", cancel));
    controller.signal.removeEventListener("abort", onAbort);
  }
}
