/**
 * Shared rate limiters — imported by both index.ts and routes.ts.
 * Kept in a separate file to avoid circular imports between index ↔ routes.
 */
import rateLimit from "express-rate-limit";
import type { RequestHandler } from "express";

// Scan routes are already authenticated, role-gated, billing-gated, validated,
// and dispatched through the one bounded provider queue. Do not apply a starts-
// per-hour limit here: authorized operators can enqueue consecutive scans while
// the provider queue supplies the actual backpressure. This middleware remains
// explicit on every spending route so admission policy has one auditable hook.
export const authorizedScanAdmission: RequestHandler = (_req, res, next) => {
  res.setHeader("X-Scan-Admission", "queued");
  next();
};

// Owner lookup rate limit: generous by default (unlimited budget posture) —
// remains only as an abuse tripwire, never a workflow blocker. 500/hr per IP.
export const ownerLookupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Owner lookup limit reached. Try again in an hour." },
});

// Public rep-application form: 5 submissions / hour per IP. This endpoint is
// unauthenticated and writes up to 20 MB of uploads to disk per request, so a
// tight cap is the primary defense against disk-exhaustion / spam abuse.
export const onboardingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many applications from this network. Please try again in an hour." },
});

// Authenticated recruiting email: high enough for ordinary hiring, bounded so
// a compromised manager session cannot turn the portal into a bulk mailer.
export const recruitingInviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Recruiting invitation limit reached. Try again in an hour." },
});

export const inviteResolveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many invitation checks. Try again shortly." },
});

// Forward geocode (/api/geocode) is reachable by any field user (scan.submit)
// and is backed by the server-side secret Mapbox token. The in-memory cache
// means only UNIQUE queries cost money — but a caller could still enumerate
// unique strings to drive paid geocoding. A generous per-IP ceiling (120/min)
// never blocks legitimate typeahead/search while capping enumeration abuse.
export const geocodeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many geocode lookups. Slow down for a moment." },
});
