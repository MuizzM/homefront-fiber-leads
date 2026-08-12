// ── The source file, encrypted at rest ───────────────────────────────────────
//
// An import keeps the file it ran on. Not for nostalgia: when a rep insists the
// report said the install was Thursday and the CRM says Friday, the only thing
// that settles it is the bytes that arrived. It is also the only way to re-run
// an import after fixing a mapping without asking an admin to find the export
// again.
//
// That file is dense customer PII, so it is stored the way the import rows are:
// AES-256-GCM, under DATA_DIR, never in the repo, never served raw. With no
// encryption key configured it is NOT stored at all - the import still runs and
// records `source_file_storage_key = null`, and the admin screen says why.
//
// The directory sits under DATA_DIR (the persistent volume) rather than
// uploads/, which is served statically by the express static middleware. A
// provider report must never be one path traversal away from being public.

import fs from "node:fs";
import path from "node:path";
import { encryptOrderPayload, decryptOrderPayload, orderPayloadEncryptionReady } from "./vendorOrderCrypto";

/** 25 MB. A submitted-orders export for a large dealer is a few MB; anything an
 *  order of magnitude past that is a mistake or an attack, and either way the
 *  answer is to refuse rather than to read it into memory. */
export const MAX_SOURCE_FILE_BYTES = 25 * 1024 * 1024;

function baseDir(): string {
  const dataDir = process.env.DATA_DIR || process.cwd();
  return path.join(dataDir, "vendor-order-imports");
}

/**
 * Write the file, encrypted, and return its storage key.
 *
 * The key is `<tenantId>/<checksum>.enc`, which is content-addressed on
 * purpose: the same file uploaded twice occupies one blob, and the checksum is
 * already the duplicate-import guard, so a key can never point at bytes whose
 * checksum does not match its own name.
 *
 * Returns null when encryption is unavailable. That is the fail-closed branch:
 * no key, no stored file.
 */
export function storeSourceFile(tenantId: number, checksum: string, content: Buffer): string | null {
  if (!orderPayloadEncryptionReady()) return null;
  if (content.length > MAX_SOURCE_FILE_BYTES) return null;
  if (!/^[a-f0-9]{64}$/i.test(checksum)) return null;

  const key = `${tenantId}/${checksum.toLowerCase()}.enc`;
  const full = path.join(baseDir(), key);
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (fs.existsSync(full)) return key;
    const sealed = encryptOrderPayload({ b64: content.toString("base64") });
    if (!sealed) return null;
    // Write to a temp name and rename: a process killed mid-write must not
    // leave a half-file that later reads as corrupt evidence.
    const tmp = `${full}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, sealed, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, full);
    return key;
  } catch (e: any) {
    console.warn("[vendor-order-files] store failed:", e?.message);
    return null;
  }
}

/**
 * Read a stored file back.
 *
 * The key is validated against a strict shape and re-joined from its parts
 * rather than trusted: it arrives from a database column, and a column is only
 * as trustworthy as everything that has ever written to it.
 */
export function readSourceFile(storageKey: string | null | undefined): Buffer | null {
  if (!storageKey) return null;
  const m = /^(\d+)\/([a-f0-9]{64})\.enc$/.exec(String(storageKey));
  if (!m) return null;
  const full = path.join(baseDir(), m[1], `${m[2]}.enc`);
  try {
    if (!fs.existsSync(full)) return null;
    const sealed = fs.readFileSync(full, "utf8");
    const payload = decryptOrderPayload(sealed);
    const b64 = payload?.b64;
    if (typeof b64 !== "string") return null;
    return Buffer.from(b64, "base64");
  } catch (e: any) {
    console.warn("[vendor-order-files] read failed:", e?.message);
    return null;
  }
}

/** Delete a stored file. Used only by retention, never by a request handler. */
export function deleteSourceFile(storageKey: string | null | undefined): boolean {
  if (!storageKey) return false;
  const m = /^(\d+)\/([a-f0-9]{64})\.enc$/.exec(String(storageKey));
  if (!m) return false;
  try {
    fs.unlinkSync(path.join(baseDir(), m[1], `${m[2]}.enc`));
    return true;
  } catch {
    return false;
  }
}
