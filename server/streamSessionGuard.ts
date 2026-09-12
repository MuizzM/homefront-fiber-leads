import type { Response } from "express";

// Includes the next frame, so even a single oversized snapshot is bounded.
export const MAX_STREAM_BUFFER_BYTES = 512 * 1024;

const installed = Symbol("sessionStreamGuard");

/** Authenticated routes opt into SSE by setting their content type. Protecting
 * the response here also covers new streams and async producers. Ordinary JSON
 * responses never run the additional authority read. Bare end() stays usable
 * during cleanup; end(payload) must satisfy the same rule as write(payload). */
export function guardSessionStream(res: Response, allowed: () => boolean): void {
  const marked = res as Response & { [installed]?: boolean };
  if (marked[installed]) return;
  marked[installed] = true;
  const write = res.write;
  const end = res.end;
  let denied = false;
  const mayWrite = (chunk: unknown) => {
    if (denied || res.writableEnded || res.destroyed) return false;
    if (!String(res.getHeader("Content-Type") ?? "").toLowerCase().startsWith("text/event-stream")) return true;
    const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : ArrayBuffer.isView(chunk) ? chunk.byteLength : 0;
    if (res.writableLength + bytes > MAX_STREAM_BUFFER_BYTES) {
      denied = true;
      res.destroy(); // release timers/listeners immediately; do not flush a slow backlog
      return false;
    }
    try { if (allowed()) return true; } catch { /* unreadable authority cannot permit a frame */ }
    denied = true;
    if (res.writableLength > 0) res.destroy();
    else Reflect.apply(end, res, []);
    return false;
  };
  const rejectCallback = (args: unknown[]) => {
    const callback = args[args.length - 1];
    if (typeof callback === "function") queueMicrotask(() => callback(Object.assign(new Error("Stream access ended"), { code: "ERR_STREAM_PREMATURE_CLOSE" })));
  };
  res.write = function (this: Response, ...args: Parameters<Response["write"]>) {
    if (mayWrite(args[0])) return Reflect.apply(write, this, args);
    rejectCallback(args);
    return false;
  } as Response["write"];
  res.end = function (this: Response, ...args: Parameters<Response["end"]>) {
    const chunk = args[0];
    if (chunk === undefined || chunk === null || typeof chunk === "function" || mayWrite(chunk)) {
      return Reflect.apply(end, this, args);
    }
    rejectCallback(args);
    return this;
  } as Response["end"];
}
