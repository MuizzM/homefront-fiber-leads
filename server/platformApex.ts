// ── Platform-owner (apex) identity ────────────────────────────────────────────
// Apex identity is stamped onto the immutable `users.is_super_admin` column at
// boot from SUPER_ADMIN_EMAILS (see runMigrations in ./storage), and three
// request-time guards refuse to let anyone else CLAIM one of those emails -
// creating a login on one, PATCHing a login onto one, or approving a public
// application that carries one. Without those guards a tenant admin could seat
// an apex email and inherit platform ownership at the next restart.
//
// The env parse used to be inlined at all four sites, each carrying its own copy
// of the fallback literal. Four copies is four places to miss during an owner
// rotation, and a guard that silently disagrees with the boot stamp is worse
// than no guard: the stamp would promote an email the guards still let someone
// else take. One definition, four callers.
//
// Read at CALL time, never memoised at import: the authz tests set and restore
// SUPER_ADMIN_EMAILS around individual cases, and a cached list would make them
// pass against a stale roster.

/** Retained deliberately - see warnIfDefaultApex. Removing it would change boot
 *  behaviour for any environment that has never set SUPER_ADMIN_EMAILS. */
const DEFAULT_APEX_EMAIL = "muizzm21@gmail.com";

/** The configured platform owners, lowercased and trimmed. Never empty. */
export function apexEmails(): string[] {
  return (process.env.SUPER_ADMIN_EMAILS ?? DEFAULT_APEX_EMAIL)
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Is this address reserved for platform ownership? Accepts anything; an empty
 *  or absent value is never apex, so a blank form field can't match. */
export function isApexEmail(email: unknown): boolean {
  const candidate = String(email ?? "").trim().toLowerCase();
  return candidate.length > 0 && apexEmails().includes(candidate);
}

/** True when nothing is configured and the fallback is what binds ownership. */
export function usingDefaultApex(): boolean {
  return process.env.SUPER_ADMIN_EMAILS == null;
}

let warned = false;
/** Announce - once - that platform ownership is resting on the compiled-in
 *  fallback rather than on deployment config. Called from the boot stamp, which
 *  is the moment the fallback actually takes effect.
 *
 *  A WARNING and not a hard exit on purpose: this process refusing to boot on a
 *  missing env var would turn a misconfiguration into an outage, and the deploy
 *  path here has no fast rollback. Make it loud, not fatal. */
export function warnIfDefaultApex(): void {
  if (warned || !usingDefaultApex()) return;
  warned = true;
  console.warn(
    `[apex] SUPER_ADMIN_EMAILS is not set - platform ownership is falling back to ` +
    `the compiled-in default (${DEFAULT_APEX_EMAIL}). Set SUPER_ADMIN_EMAILS ` +
    `explicitly in this environment; see .env.example.`,
  );
}
