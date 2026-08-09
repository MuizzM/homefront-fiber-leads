/**
 * Shared rate limiters — imported by both index.ts and routes.ts.
 * Kept in a separate file to avoid circular imports between index ↔ routes.
 */
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request, RequestHandler } from "express";
import { can as hasCapability } from "@shared/capabilities";
import {
  isScanMutationPath, isScanPollPath, isScanReadPath,
  scanMutationRateLimitMax, scanReadRateLimitMax, scanPollRateLimitMax,
  rescanPoolRateLimitMax, chatReadRateLimitMax, chatWriteRateLimitMax,
} from "./rateLimitPolicy";

// Scan routes are already authenticated, role-gated, and dispatched through the
// one bounded provider queue. This middleware remains explicit on every
// spending route so admission policy has one auditable hook — and it is a REAL
// admission check, not a no-op: the session must be resolved (an auth gate
// always runs before this on money-spending routes) and the caller must hold
// the scan.submit capability (team lead and up; reps cannot spend scan budget).
export const authorizedScanAdmission: RequestHandler = (req, res, next) => {
  const user = (req as any).user;
  if (!user || !user.id || !user.role) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  if (!hasCapability(user.role, "scan.submit")) {
    return res.status(403).json({ error: "Forbidden", need: "scan.submit" });
  }
  res.setHeader("X-Scan-Admission", "queued");
  next();
};

// ── Per-user keying ─────────────────────────────────────────────────────────
// Authenticated abuse is per-ACCOUNT, not per-IP: a field team behind one
// carrier NAT shares an IP, and one hijacked session can roam across IPs. Key
// on the session token when present (one token = one signed-in user), falling
// back to the resolved client IP for unauthenticated traffic.
// The IP fallback MUST go through ipKeyGenerator. A raw req.ip keys IPv6 on the
// full /128 address, and a single residential IPv6 allocation is a /64 — so one
// caller holding a /64 has 2^64 distinct keys and every limiter below becomes a
// no-op for them. ipKeyGenerator collapses IPv6 to its subnet so the bucket is
// per-CUSTOMER, not per-address. IPv4 is returned unchanged.
export function perUserKey(req: Request): string {
  const sid = req.headers["x-session-id"];
  if (typeof sid === "string" && sid) return `u:${sid}`;
  return `ip:${ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown")}`;
}

/**
 * Rate-limit bucket key for a bare IP, for buckets that aren't express-rate-
 * limit's (the SQLite-backed OTP buckets). Same reasoning as perUserKey: keying
 * the full IPv6 /128 hands one caller their whole /64 worth of buckets. Exported
 * so check/reset on the same address can never derive different keys — a reset
 * that misses its bucket is a lockout nobody can clear.
 *
 * Bucketing only. Audit trails must keep logging the FULL address.
 */
export function ipBucketKey(ip: string): string {
  return `ip:${ipKeyGenerator(ip)}`;
}

interface BudgetOptions {
  windowMs?: number;
  max: number;
  message: string;
  /** Restrict to these HTTP methods (default: all). */
  methods?: string[];
}

/** Factory so tests can build small-max buckets against the same policy. */
export function createPerUserLimiter(opts: BudgetOptions): RequestHandler {
  const methods = opts.methods?.map((m) => m.toUpperCase());
  return rateLimit({
    windowMs: opts.windowMs ?? 60 * 60 * 1000,
    max: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: opts.message },
    keyGenerator: perUserKey,
    skip: methods ? (req) => !methods.includes(req.method.toUpperCase()) : undefined,
  });
}

// ── Dedicated scan budgets (SEC-B fix: no more blanket exemption) ───────────
export interface ScanBudgetOverrides {
  mutationMax?: number;
  readMax?: number;
  pollMax?: number;
}

/**
 * One dispatcher that meters EVERY scan-workflow path into exactly one
 * per-user bucket. Mounted at the app root in index.ts (before routes) so the
 * policy lives in one place instead of being repeated on ~30 route handlers:
 *   • POST money-spending mutations → mutation bucket (default 120/hour)
 *   • GET hot progress polls        → poll bucket     (default 3600/hour)
 *   • GET other scan reads          → read bucket     (default 600/hour)
 */
export function scanWorkflowRateLimits(overrides: ScanBudgetOverrides = {}): RequestHandler {
  const mutationLimiter = createPerUserLimiter({
    max: overrides.mutationMax ?? scanMutationRateLimitMax(process.env.SCAN_MUTATION_RATE_LIMIT_MAX),
    methods: ["POST"],
    message: "Scan launch budget reached for this account. Try again in an hour.",
  });
  const readLimiter = createPerUserLimiter({
    max: overrides.readMax ?? scanReadRateLimitMax(process.env.SCAN_READ_RATE_LIMIT_MAX),
    methods: ["GET", "HEAD"],
    message: "Scan read budget reached for this account. Try again in an hour.",
  });
  const pollLimiter = createPerUserLimiter({
    max: overrides.pollMax ?? scanPollRateLimitMax(process.env.SCAN_POLL_RATE_LIMIT_MAX),
    methods: ["GET", "HEAD"],
    message: "Scan polling budget reached for this account. Slow down or use the live stream.",
  });
  return (req, res, next) => {
    const path = req.path;
    if (req.method === "POST" && isScanMutationPath(path)) return mutationLimiter(req, res, next);
    if (req.method === "GET" || req.method === "HEAD") {
      if (isScanPollPath(path)) return pollLimiter(req, res, next);
      if (isScanReadPath(path)) return readLimiter(req, res, next);
    }
    next();
  };
}

// POST /api/scan/rescan-pool re-qualifies up to 10k stored addresses per call —
// the single most expensive scan mutation. A handful of launches per hour per
// account is generous; anything beyond that is automation, not field work.
export const rescanPoolLimiter = createPerUserLimiter({
  max: rescanPoolRateLimitMax(process.env.RESCAN_POOL_RATE_LIMIT_MAX),
  methods: ["POST"],
  message: "Pool re-scan budget reached. Try again in an hour.",
});

// ── Money-mutation limiters (SEC-B) ─────────────────────────────────────────
// Wired by path in index.ts (these routes live in sibling-owned modules); the
// global bucket remains as a backstop underneath them.

// Payout week pay + week transitions move real money. 30/hour per account.
export const payoutTransitionLimiter = createPerUserLimiter({
  max: 30,
  methods: ["POST"],
  message: "Too many payout actions. Try again in an hour.",
});

// Pay disputes (create + resolve): 30/hour per account. Reads stay unmetered.
export const payDisputeLimiter = createPerUserLimiter({
  max: 30,
  methods: ["POST", "PATCH"],
  message: "Too many pay-dispute actions. Try again in an hour.",
});

// Punch corrections rewrite payable time: 30/hour per account.
export const punchCorrectionLimiter = createPerUserLimiter({
  max: 30,
  methods: ["POST"],
  message: "Too many punch corrections. Try again in an hour.",
});

// Document (counter-)signing is a legal act, not a polling loop: 30/hour.
export const documentSignLimiter = createPerUserLimiter({
  max: 30,
  methods: ["POST"],
  message: "Too many signing attempts. Try again in an hour.",
});

// Knock POSTs are the highest-frequency field write; 60/hour per account
// leaves ordinary knocking untouched (a rep walks ~20-40 doors/hour) while
// capping scripted fabrication from a hijacked session.
export const knockPostLimiter = createPerUserLimiter({
  max: 60,
  methods: ["POST"],
  message: "Knock logging budget reached. Try again in an hour.",
});

// ── Floor-chat budgets ──────────────────────────────────────────────────────
// Chat paths skip the GLOBAL per-IP bucket (rateLimitPolicy.isChatPath — the
// 4s room poll behind one carrier NAT must never 429 a whole field team), so
// like the scan workflow, every chat path is metered PER USER instead.

// Message POSTs are conversation, not automation: 120/hour per account is a
// message every 30 seconds sustained, which no thumb keeps up for an hour —
// while capping what a hijacked session can spray into a room every phone in
// the org polls. Rides the POST /api/chat route only (same inline pattern as
// geocodeLimiter).
export const chatPostLimiter = createPerUserLimiter({
  max: 120,
  methods: ["POST"],
  message: "Slow down a moment - the floor can only read so fast.",
});

// The room poll. Sized like the scan progress poll: sustained refresh on a
// couple of devices, never a workflow blocker.
export const chatReadLimiter = createPerUserLimiter({
  max: chatReadRateLimitMax(process.env.CHAT_READ_RATE_LIMIT_MAX),
  methods: ["GET", "HEAD"],
  message: "Chat refresh budget reached for this account. The room updates on its own - give it a moment.",
});

// Read-marks and deletes. Message posts also pass through here (same path
// prefix) but their own 120/hour bucket above binds first, so this ceiling
// only really governs POST /api/chat/read and DELETE /api/chat/:id.
export const chatWriteLimiter = createPerUserLimiter({
  max: chatWriteRateLimitMax(process.env.CHAT_WRITE_RATE_LIMIT_MAX),
  methods: ["POST", "DELETE"],
  message: "Too many chat actions. Try again shortly.",
});

// Manual calling attempt starts dial real phone numbers: 30/hour per account.
export const callingAttemptLimiter = createPerUserLimiter({
  max: 30,
  methods: ["POST"],
  message: "Calling-attempt budget reached. Try again in an hour.",
});

// NACHA + week CSV exports contain bank-level payout data: 20/hour per account.
export const moneyExportLimiter = createPerUserLimiter({
  max: 20,
  methods: ["GET"],
  message: "Export budget reached. Try again in an hour.",
});

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

// Pay-plane self-service writes (bank details + W-9). Authenticated and
// own-record only, but these endpoints accept the most sensitive identifiers
// in the product (bank numbers, TINs) — a tight per-IP ceiling blunts
// credential-stuffing / scripted probing of a hijacked session.
export const payWriteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many pay-profile updates. Please try again in an hour." },
});
