import type { Request, Response } from "express";
import { SseConnectionCaps } from "./scanSseCaps";

// Shared across inspector, fiber operations and discovery feeds; one account
// cannot multiply subscriptions by using a different diagnostic endpoint.
export const diagnosticSseCaps = new SseConnectionCaps();
export function admitDiagnosticStream(req: Request, res: Response): boolean {
  const acquired = diagnosticSseCaps.tryAcquire(String((req as any).user.id));
  if (!acquired.ok) {
    res.setHeader("Retry-After", "5");
    res.status(429).json({ error: "Too many diagnostic streams open" });
    return false;
  }
  const timer = setTimeout(() => res.destroy(), diagnosticSseCaps.options.maxDurationMs);
  timer.unref();
  const cleanup = () => { clearTimeout(timer); acquired.grant.release(); };
  req.once("close", cleanup);
  res.once("close", cleanup);
  return true;
}
