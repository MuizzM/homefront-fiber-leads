import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sniffUploadKind, sniffUploadedFile, uploadKindAllowed } from "../../server/uploadSniff";

// Tiny magic-byte fixtures — just enough for the sniffer's 16-byte read.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const WEBP = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from("WEBP", "ascii")]);
const PDF = Buffer.from("%PDF-1.7\n", "ascii");
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]); // MZ executable
const HTML = Buffer.from("<html><body>", "ascii");

describe("upload magic-byte sniffing", () => {
  it("classifies the accepted formats by content", () => {
    expect(sniffUploadKind(JPEG)).toBe("jpeg");
    expect(sniffUploadKind(PNG)).toBe("png");
    expect(sniffUploadKind(WEBP)).toBe("webp");
    expect(sniffUploadKind(PDF)).toBe("pdf");
  });

  it("rejects non-image content regardless of what it claims to be", () => {
    expect(sniffUploadKind(EXE)).toBeNull();
    expect(sniffUploadKind(HTML)).toBeNull();
    expect(sniffUploadKind(Buffer.alloc(0))).toBeNull();
    expect(sniffUploadKind(Buffer.from([0xff, 0xd8]))).toBeNull(); // truncated
  });

  describe("on-disk files (the multer write path)", () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "hf-sniff-")); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    const write = (name: string, buf: Buffer) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, buf);
      return p;
    };

    it("accepts a real JPEG even with a misleading name", () => {
      const p = write("totally-a-photo.jpg.exe", JPEG);
      expect(sniffUploadedFile(p)).toBe("jpeg");
      expect(uploadKindAllowed(p, ["jpeg", "png", "webp"])).toBe(true);
    });

    it("rejects an executable renamed to .jpg (the attack this fixes)", () => {
      const p = write("photo.jpg", EXE);
      expect(sniffUploadedFile(p)).toBeNull();
      expect(uploadKindAllowed(p, ["jpeg", "png", "webp"])).toBe(false);
    });

    it("rejects an HTML/JS polyglot renamed to .png", () => {
      const p = write("evidence.png", HTML);
      expect(uploadKindAllowed(p, ["jpeg", "png", "webp"])).toBe(false);
    });

    it("allows PDF only where the route accepts it (license, not photo)", () => {
      const p = write("license.pdf", PDF);
      expect(uploadKindAllowed(p, ["jpeg", "png", "webp", "pdf"])).toBe(true);
      expect(uploadKindAllowed(p, ["jpeg", "png", "webp"])).toBe(false);
    });

    it("returns null for a missing file instead of throwing", () => {
      expect(sniffUploadedFile(path.join(dir, "nope.jpg"))).toBeNull();
    });
  });
});
