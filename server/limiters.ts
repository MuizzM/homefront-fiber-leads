/**
 * Shared rate limiters — imported by both index.ts and routes.ts.
 * Kept in a separate file to avoid circular imports between index ↔ routes.
 */
import rateLimit from "express-rate-limit";

// Scan rate limit: 3 scans / hour per IP (expensive operation)
export const scanLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Scan rate limit reached. Maximum 3 scans per hour." },
});

// Owner lookup rate limit: 20 hits / hour per IP (each costs $0.20)
export const ownerLookupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
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
