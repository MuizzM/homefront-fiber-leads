import type { NextFunction, Request, Response } from "express";

/**
 * An injected Express middleware (requireAuth, requireCapability(...), rate
 * limiters). Return type is `void` on purpose: Express ignores middleware
 * return values, and a void-returning function type still accepts handlers
 * that `return res.json(...)` for early exit. Route modules previously each
 * declared their own copy of this type with an `unknown` return; this is the
 * single owner.
 */
export type Middleware = (req: Request, res: Response, next: NextFunction) => void;
