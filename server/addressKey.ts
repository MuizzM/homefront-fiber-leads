// Moved to shared/ so the CLIENT's render-time dedupe uses the SAME canonical
// address identity as the server (one normalization, one alias table — the
// client-side house key had its own weaker rules and split/merged wrong).
// This re-export keeps every existing server import path working.
export * from "@shared/addressKey";
