// Expiring signed links for things we TEXT TO A CUSTOMER.
//
// "Confirm your install", "reschedule", "here's how to prep", "contact your
// rep" all arrive as an SMS. An SMS is not a private channel: it sits in the
// handset's message log, in screenshots the customer forwards to a spouse, in
// carrier and link-shortener logs, and in whatever backup the phone syncs to.
// Every token minted here should be treated as PUBLIC the moment it is sent.
//
// That threat model drives every decision below:
//
//   • The token carries an OPAQUE reference, never a row id. A customer who
//     receives token for install #4218 must not be able to derive #4219 — an
//     incrementing id in a link is an enumeration primitive handed to anyone
//     with a phone. `deriveRef` blinds an internal id through the same HMAC
//     secret, so the reference is stable (the server can index it) but not
//     reversible or guessable without the secret.
//
//   • The expiry lives INSIDE the signed material. An `?exp=` query parameter
//     next to the signature is decoration — the holder edits it. Here `exp` is
//     part of the bytes the MAC covers, so moving it invalidates the token.
//
//   • The PURPOSE is signed too, and `verifyLink` cannot be called without
//     declaring which purpose the caller expects. This is the privilege
//     escalation case: a "view prep instructions" link is handed out freely and
//     must never be replayable against the "confirm installation" endpoint.
//
//   • The signature compare is constant-time. A byte-by-byte early return is a
//     timing oracle that lets an attacker walk a forgery out one byte at a time.
//
//   • Failure is a VALUE, not an exception. Carriers rewrite links, customers
//     paste half of one back into a chat. A mangled token is expected traffic;
//     it returns `{ valid: false, reason }` so the caller can log and respond,
//     not a 500.
//
// Dependency-free beyond node:crypto by design — this is the kind of module
// that should be auditable in one sitting.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Token format version. Signed, so a v1 token can never be replayed as a v2. */
const VERSION = "v1";

/** Bytes of entropy in the per-token nonce. */
const NONCE_BYTES = 12;

/** Bytes kept from the HMAC when blinding an internal id into a reference. */
const REF_BYTES = 16; // 128 bits — unguessable, still short enough for an SMS

/**
 * The shortest reference we will sign. Anything shorter is almost certainly a
 * raw identifier that somebody pasted in, which is exactly what this module
 * exists to keep out of a text message.
 */
const MIN_REF_LENGTH = 16;

/**
 * What the recipient is allowed to DO with the link. Bound into the signature.
 * Adding a value here is a security decision: each one is a distinct capability
 * that a token for any other purpose must not unlock.
 */
export type LinkPurpose =
  | "confirm-installation"
  | "reschedule-installation"
  | "view-prep-instructions"
  | "contact-rep";

const LINK_PURPOSES: readonly LinkPurpose[] = [
  "confirm-installation",
  "reschedule-installation",
  "view-prep-instructions",
  "contact-rep",
];

/**
 * Extra fields a page may want without a database round trip (e.g. the install
 * window to render before the row is loaded).
 *
 * WARNING: this is base64 in a text message, not encryption. Anything put here
 * is readable by anyone holding the link. Never put a name, address, phone
 * number, or internal id in `meta`.
 */
export type LinkMeta = Record<string, string | number | boolean>;

/** What the caller asks to be signed. */
export interface SignLinkInput {
  /**
   * Opaque handle for the record. Use `deriveRef`, or a random column on the
   * row. Never a primary key — `signLink` rejects bare digit strings.
   */
  ref: string;
  purpose: LinkPurpose;
  /** Optional unix-seconds instant before which the token is not yet valid. */
  notBefore?: number;
  meta?: LinkMeta;
}

/** The full signed body, as returned by a successful `verifyLink`. */
export interface SignedLinkPayload {
  v: typeof VERSION;
  ref: string;
  purpose: LinkPurpose;
  /** Unix seconds. EXCLUSIVE: the token is dead at `exp`, alive at `exp - 1`. */
  exp: number;
  /** Unix seconds. Inclusive lower bound, present only when requested. */
  nbf?: number;
  /** Per-token randomness so two links for the same record are distinguishable. */
  nonce: string;
  meta?: LinkMeta;
}

export interface SignLinkOptions {
  /** HMAC key. No default, ever — a default secret is the same as no secret. */
  secret: string;
  /** Lifetime in whole seconds. Must be a positive integer. */
  ttlSeconds: number;
  /** Unix seconds "now". Injectable so tests can pin the expiry boundary. */
  now?: number;
  /** Test seam only. Leave unset in production so the nonce stays random. */
  nonce?: string;
}

export interface VerifyLinkOptions {
  secret: string;
  /**
   * The purpose the CALLING ENDPOINT grants. Required, not optional: making
   * this mandatory is what stops a route from accidentally accepting any
   * validly-signed token regardless of what it was minted for.
   */
  purpose: LinkPurpose;
  now?: number;
}

/**
 * Why a token was rejected. A closed union so callers must handle each case;
 * `bad-signature` deliberately covers both forgery and truncation, because
 * distinguishing them tells an attacker how far along they are.
 */
export type VerifyFailureReason =
  | "malformed"
  | "bad-signature"
  | "purpose-mismatch"
  | "not-yet-valid"
  | "expired";

export type VerifyLinkResult =
  | { valid: true; payload: SignedLinkPayload }
  | { valid: false; reason: VerifyFailureReason };

/* ------------------------------------------------------------------ */
/* encoding                                                            */
/* ------------------------------------------------------------------ */

/**
 * base64url, unpadded. `+`, `/` and `=` do not survive a trip through link
 * shorteners, carrier rewriting, or a customer double-tapping to select a URL,
 * so they never appear in a token.
 */
function encodeSegment(bytes: Buffer): string {
  return bytes.toString("base64url");
}

const SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Strict decode. `Buffer.from(s, "base64url")` silently skips characters it
 * does not understand, which would let two different token strings decode to
 * the same bytes; the pattern check closes that off and turns carrier-mangled
 * input into an honest `malformed`.
 */
function decodeSegment(segment: string): Buffer | null {
  if (!SEGMENT_PATTERN.test(segment)) return null;
  return Buffer.from(segment, "base64url");
}

/* ------------------------------------------------------------------ */
/* guards                                                              */
/* ------------------------------------------------------------------ */

/**
 * A missing secret is a deployment fault, not untrusted input, so it throws
 * rather than returning a reason — silently verifying with `""` would mean
 * every forged token is accepted, and the caller must not be able to ignore it.
 */
function requireSecret(secret: unknown, operation: "sign" | "verify"): string {
  if (typeof secret !== "string" || secret.trim().length === 0) {
    throw new TypeError(
      `signedLinks: refusing to ${operation} without a secret. ` +
        "Supply opts.secret from configuration; there is no default.",
    );
  }
  return secret;
}

function hmac(secret: string, message: string): Buffer {
  return createHmac("sha256", secret).update(message, "utf8").digest();
}

/**
 * Length-checked `timingSafeEqual`. The native call THROWS on unequal lengths,
 * which for a truncated SMS link would surface as a 500 instead of a rejection,
 * so the length is compared first. Only the length leaks, and for an honestly
 * generated token the length is always 32 bytes.
 */
function constantTimeEquals(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isLinkPurpose(value: unknown): value is LinkPurpose {
  return typeof value === "string" && (LINK_PURPOSES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Blind an internal id into a stable, opaque reference.
 *
 * `deriveRef("installation", 4218, secret)` is deterministic, so the server can
 * store or index it and look the row back up, but it is not invertible and not
 * enumerable without the secret: holding the reference for #4218 tells you
 * nothing about #4219.
 *
 * `kind` namespaces the id so installation 7 and lead 7 never collide.
 *
 * Known limitation: because it is deterministic, two links for the same record
 * carry the same reference, so a party holding both can tell they are related.
 * Unlinkable references need a random per-token column on the row.
 */
export function deriveRef(kind: string, id: string | number, secret: string): string {
  requireSecret(secret, "sign");
  if (typeof kind !== "string" || kind.trim().length === 0) {
    throw new TypeError("signedLinks: deriveRef requires a non-empty kind.");
  }
  const digest = hmac(secret, `ref:${VERSION}:${kind}:${String(id)}`);
  return encodeSegment(digest.subarray(0, REF_BYTES));
}

/**
 * Mint a token. Returns `"v1.<payload>.<signature>"`, all base64url.
 *
 * Throws only on caller error — no secret, a nonsensical TTL, or a `ref` that
 * looks like a raw internal id. Those are bugs in the calling code and must be
 * loud; they are never triggered by anything a customer can send.
 */
export function signLink(payload: SignLinkInput, opts: SignLinkOptions): string {
  const secret = requireSecret(opts?.secret, "sign");

  const ttl = opts.ttlSeconds;
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new TypeError("signedLinks: ttlSeconds must be a positive whole number of seconds.");
  }

  const ref = payload?.ref;
  if (typeof ref !== "string" || ref.length < MIN_REF_LENGTH) {
    throw new TypeError(
      `signedLinks: ref must be an opaque string of at least ${MIN_REF_LENGTH} characters. ` +
        "Use deriveRef() or a random column — never a primary key.",
    );
  }
  if (/^\d+$/.test(ref)) {
    // A digits-only reference is an internal id wearing a disguise. Refusing it
    // is the only place this rule can be enforced for every caller.
    throw new TypeError("signedLinks: ref must not be a bare numeric id.");
  }

  if (!isLinkPurpose(payload.purpose)) {
    throw new TypeError(`signedLinks: unknown purpose ${String(payload.purpose)}.`);
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(now)) {
    throw new TypeError("signedLinks: now must be a finite unix-seconds value.");
  }

  const body: SignedLinkPayload = {
    v: VERSION,
    ref,
    purpose: payload.purpose,
    exp: Math.floor(now) + ttl,
    nonce: opts.nonce ?? encodeSegment(randomBytes(NONCE_BYTES)),
  };

  if (payload.notBefore !== undefined) {
    if (!Number.isInteger(payload.notBefore)) {
      throw new TypeError("signedLinks: notBefore must be unix seconds as a whole number.");
    }
    body.nbf = payload.notBefore;
  }
  if (payload.meta !== undefined) {
    body.meta = payload.meta;
  }

  // The version is inside the signed material alongside the body, so a token
  // can never be re-labelled as a different format revision.
  const signingInput = `${VERSION}.${encodeSegment(Buffer.from(JSON.stringify(body), "utf8"))}`;
  return `${signingInput}.${encodeSegment(hmac(secret, signingInput))}`;
}

/**
 * Check a token. Never throws for bad input — only for a missing secret.
 *
 * Check order is deliberate: the MAC is verified BEFORE the payload JSON is
 * parsed, so untrusted structure is never interpreted until it is known to be
 * ours. Purpose is checked before the clock so that a replay attempt against
 * the wrong endpoint reports as such even after the token would have expired.
 */
export function verifyLink(token: string, opts: VerifyLinkOptions): VerifyLinkResult {
  const secret = requireSecret(opts?.secret, "verify");
  if (!isLinkPurpose(opts.purpose)) {
    throw new TypeError(
      "signedLinks: verifyLink requires the purpose the calling endpoint grants.",
    );
  }

  if (typeof token !== "string" || token.length === 0) {
    return { valid: false, reason: "malformed" };
  }

  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, reason: "malformed" };

  const [version, bodySegment, signatureSegment] = parts;
  if (version !== VERSION) return { valid: false, reason: "malformed" };

  const signature = decodeSegment(signatureSegment);
  if (signature === null) return { valid: false, reason: "malformed" };
  if (!SEGMENT_PATTERN.test(bodySegment)) return { valid: false, reason: "malformed" };

  const expected = hmac(secret, `${version}.${bodySegment}`);
  if (!constantTimeEquals(signature, expected)) {
    return { valid: false, reason: "bad-signature" };
  }

  // Authenticated from here down.
  const bodyBytes = decodeSegment(bodySegment);
  if (bodyBytes === null) return { valid: false, reason: "malformed" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyBytes.toString("utf8"));
  } catch {
    return { valid: false, reason: "malformed" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { valid: false, reason: "malformed" };
  }

  const body = parsed as Partial<SignedLinkPayload>;
  if (
    body.v !== VERSION ||
    typeof body.ref !== "string" ||
    body.ref.length === 0 ||
    !isLinkPurpose(body.purpose) ||
    !Number.isFinite(body.exp) ||
    typeof body.nonce !== "string"
  ) {
    return { valid: false, reason: "malformed" };
  }
  if (body.nbf !== undefined && !Number.isFinite(body.nbf)) {
    return { valid: false, reason: "malformed" };
  }

  if (body.purpose !== opts.purpose) {
    return { valid: false, reason: "purpose-mismatch" };
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (body.nbf !== undefined && now < body.nbf) {
    return { valid: false, reason: "not-yet-valid" };
  }
  if (now >= (body.exp as number)) {
    return { valid: false, reason: "expired" };
  }

  return { valid: true, payload: body as SignedLinkPayload };
}
