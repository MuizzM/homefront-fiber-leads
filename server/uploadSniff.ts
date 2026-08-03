/**
 * Upload content sniffing (SEC-B).
 *
 * Extension/MIME-based filtering only inspects what the client CLAIMS a file
 * is — a renamed script or polyglot sails through multer's fileFilter. These
 * helpers read the first bytes of what ACTUALLY landed on disk and match
 * against the magic-byte signatures of the formats we accept:
 *   JPEG  FF D8 FF
 *   PNG   89 50 4E 47 0D 0A 1A 0A
 *   WEBP  "RIFF" .... "WEBP"
 *   PDF   "%PDF-"
 */
import fs from "fs";

export type UploadKind = "jpeg" | "png" | "webp" | "pdf";

const SNIFF_BYTES = 16;

export function sniffUploadKind(head: Buffer): UploadKind | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (
    head.length >= 8 &&
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
    head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a
  ) return "png";
  if (
    head.length >= 12 &&
    head.toString("ascii", 0, 4) === "RIFF" &&
    head.toString("ascii", 8, 12) === "WEBP"
  ) return "webp";
  if (head.length >= 5 && head.toString("ascii", 0, 5) === "%PDF-") return "pdf";
  return null;
}

/** Read the leading bytes of an on-disk upload and classify them (null = unrecognized). */
export function sniffUploadedFile(path: string): UploadKind | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(path, "r");
    const head = Buffer.alloc(SNIFF_BYTES);
    const read = fs.readSync(fd, head, 0, SNIFF_BYTES, 0);
    if (read <= 0) return null;
    return sniffUploadKind(head.subarray(0, read));
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/** True when the file's detected kind is one of the accepted formats. */
export function uploadKindAllowed(path: string, accepted: readonly UploadKind[]): boolean {
  const kind = sniffUploadedFile(path);
  return kind !== null && accepted.includes(kind);
}
