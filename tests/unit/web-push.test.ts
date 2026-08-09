// Web push crypto, verified against the spec rather than against itself.
//
// This is hand-rolled ECDH + HKDF + AES-GCM + ES256. Hand-rolled crypto that is
// only tested by its own round-trip is worthless — it would pass while producing
// something Apple and Google both reject. So every test here decodes the output
// the way the OTHER side would:
//
//   · the VAPID JWT is verified with a standard verifier against the public key
//   · the payload is DECRYPTED with an independent implementation of RFC 8291,
//     written from the spec rather than by calling our own helpers
//
// If these pass, a real push service will accept the bytes.
import { describe, expect, it } from "vitest";
import {
  createECDH, createHmac, createVerify, createPublicKey, createDecipheriv,
} from "node:crypto";
import { generateVapidKeys, vapidHeader, encryptPayload } from "../../server/webPush";

const b64u = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** r||s → DER, so a standard verifier can check our JOSE signature. */
function joseToDer(j: Buffer): Buffer {
  const trim = (x: Buffer) => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i += 1;
    const v = x.subarray(i);
    return (v[0]! & 0x80) ? Buffer.concat([Buffer.from([0]), v]) : v;
  };
  const r = trim(j.subarray(0, 32)), s = trim(j.subarray(32));
  const seq = Buffer.concat([Buffer.from([0x02, r.length]), r, Buffer.from([0x02, s.length]), s]);
  return Buffer.concat([Buffer.from([0x30, seq.length]), seq]);
}

const SPKI_P256 = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");
const publicKeyObject = (raw: Buffer) =>
  createPublicKey({ key: Buffer.concat([SPKI_P256, raw]), format: "der", type: "spki" });

/** RFC 8291 decryption, written from the spec — deliberately NOT using our own
 *  hkdf helper, so a bug in it cannot cancel itself out. */
function decryptAsBrowser(body: Buffer, clientEcdh: ReturnType<typeof createECDH>, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const serverPub = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);

  const shared = clientEcdh.computeSecret(serverPub);
  const derive = (sl: Buffer, ikm: Buffer, info: Buffer, len: number) => {
    const prk = createHmac("sha256", sl).update(ikm).digest();
    return createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, len);
  };
  const ikm = derive(auth, shared,
    Buffer.concat([Buffer.from("WebPush: info\0"), clientEcdh.getPublicKey(), serverPub]), 32);
  const cek = derive(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = derive(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);

  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  expect(plain[plain.length - 1]).toBe(0x02);   // last-record delimiter
  return plain.subarray(0, plain.length - 1).toString("utf8");
}

describe("VAPID keys", () => {
  it("are a real P-256 pair, the right size", () => {
    const k = generateVapidKeys();
    // 65 = uncompressed point (0x04 ‖ X ‖ Y). A 33-byte compressed key is
    // rejected by push services.
    expect(unb64u(k.publicKey).length).toBe(65);
    expect(unb64u(k.publicKey)[0]).toBe(0x04);
    expect(unb64u(k.privateKey).length).toBe(32);
  });

  it("are different every time", () => {
    expect(generateVapidKeys().privateKey).not.toBe(generateVapidKeys().privateKey);
  });
});

describe("the VAPID JWT is one a push service will accept", () => {
  const keys = { ...generateVapidKeys(), subject: "mailto:ops@homefront.test" };
  const endpoint = "https://web.push.apple.com/QAbc123";
  const now = Date.UTC(2026, 7, 3, 12, 0, 0);
  const header = vapidHeader(endpoint, keys, now);
  const token = header.match(/t=([^,]+)/)![1]!;
  const [h, b, s] = token.split(".");

  it("verifies against the public key with a standard verifier", () => {
    // The test that matters. A self-consistent signature that a real verifier
    // rejects is the exact failure hand-rolled ES256 produces, because DER and
    // JOSE encode the same numbers differently.
    const v = createVerify("SHA256");
    v.update(`${h}.${b}`);
    expect(v.verify(publicKeyObject(unb64u(keys.publicKey)), joseToDer(unb64u(s!)))).toBe(true);
  });

  it("signs 64 raw bytes, not DER", () => {
    // DER signatures are 70–72 bytes and vary in length. A JWT needs exactly 64.
    expect(unb64u(s!).length).toBe(64);
  });

  it("survives a signature whose halves have a high bit set", () => {
    // DER inserts a 0x00 pad byte when r or s has its top bit set, which shifts
    // every offset. Signing repeatedly walks into that case within a few tries.
    for (let i = 0; i < 40; i += 1) {
      const k = { ...generateVapidKeys(), subject: "mailto:x@y.test" };
      const t = vapidHeader(endpoint, k, now + i).match(/t=([^,]+)/)![1]!;
      const [hh, bb, ss] = t.split(".");
      expect(unb64u(ss!).length).toBe(64);
      const v = createVerify("SHA256");
      v.update(`${hh}.${bb}`);
      expect(v.verify(publicKeyObject(unb64u(k.publicKey)), joseToDer(unb64u(ss!)))).toBe(true);
    }
  });

  it("claims the endpoint's ORIGIN as the audience, not the full URL", () => {
    const claims = JSON.parse(unb64u(b!).toString());
    expect(claims.aud).toBe("https://web.push.apple.com");
    expect(claims.sub).toBe("mailto:ops@homefront.test");
  });

  it("expires inside the 24h the spec allows", () => {
    const claims = JSON.parse(unb64u(b!).toString());
    const secondsOut = claims.exp - Math.floor(now / 1000);
    expect(secondsOut).toBeGreaterThan(60 * 60);
    expect(secondsOut).toBeLessThan(24 * 60 * 60);
  });

  it("carries the public key in the k= parameter", () => {
    expect(header).toContain(`k=${keys.publicKey}`);
    expect(header.startsWith("vapid t=")).toBe(true);
  });
});

describe("the payload is encrypted the way a browser decrypts it", () => {
  const makeSub = () => {
    const client = createECDH("prime256v1");
    client.generateKeys();
    const auth = Buffer.from("0f1e2d3c4b5a69788796a5b4", "hex");   // 12? no — 16 below
    const auth16 = Buffer.concat([auth, Buffer.from([1, 2, 3, 4])]).subarray(0, 16);
    return {
      client, auth: auth16,
      sub: { endpoint: "https://x", p256dh: b64u(client.getPublicKey()), auth: b64u(auth16) },
    };
  };

  it("round-trips through an independent RFC 8291 decryptor", () => {
    const { client, auth, sub } = makeSub();
    const msg = JSON.stringify({ title: "Power Hour is live", body: "Close one in 60 minutes → $50" });
    expect(decryptAsBrowser(encryptPayload(sub, msg), client, auth)).toBe(msg);
  });

  it("handles non-ASCII - a rep's name is not guaranteed to be Latin", () => {
    const { client, auth, sub } = makeSub();
    const msg = JSON.stringify({ title: "José R. just closed one - 🔥" });
    expect(decryptAsBrowser(encryptPayload(sub, msg), client, auth)).toBe(msg);
  });

  it("uses a FRESH ephemeral key per message", () => {
    // Reusing one would let anyone who recovered a single message key read every
    // message to that subscriber.
    const { sub } = makeSub();
    const a = encryptPayload(sub, "x"), b = encryptPayload(sub, "x");
    const keyA = a.subarray(21, 21 + a[20]!), keyB = b.subarray(21, 21 + b[20]!);
    expect(keyA.equals(keyB)).toBe(false);
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false);  // and a fresh salt
  });

  it("writes a self-describing aes128gcm header", () => {
    const { sub } = makeSub();
    const body = encryptPayload(sub, "hello");
    expect(body.subarray(0, 16).length).toBe(16);        // salt
    expect(body.readUInt32BE(16)).toBe(4096);            // record size
    expect(body[20]).toBe(65);                           // key id length
    expect(body[21]).toBe(0x04);                         // uncompressed point
  });

  it("a tampered ciphertext fails to open rather than decoding to garbage", () => {
    const { client, auth, sub } = makeSub();
    const body = encryptPayload(sub, "Power Hour is live");
    body[body.length - 20] ^= 0xff;                      // flip a bit in the ciphertext
    expect(() => decryptAsBrowser(body, client, auth)).toThrow();
  });
});

describe("the short-scalar bug", () => {
  it("pads a private key that node returned with leading zeros stripped", () => {
    // createECDH().getPrivateKey() returns the scalar as a big-endian integer,
    // so ~1 key in 256 comes back as 31 bytes (measured: 19 of 3000). The
    // PKCS#8 template declares a fixed 32-byte OCTET STRING, so a short key
    // produced DER that OpenSSL rejected with "not enough data".
    //
    // VAPID keys are generated ONCE and stored, so an org that minted a short
    // key would have had every push fail forever, with an ASN.1 error nobody
    // would connect to notifications not arriving.
    //
    // Simulated directly by handing vapidHeader a key with a leading zero.
    const k = generateVapidKeys();
    const raw = unb64u(k.privateKey);
    raw[0] = 0;                                   // force a leading zero byte
    const stripped = Buffer.from(raw.subarray(1)); // what node would have given us
    const shortKey = {
      publicKey: k.publicKey,
      privateKey: b64u(stripped),
      subject: "mailto:x@y.test",
    };
    expect(stripped.length).toBe(31);
    expect(() => vapidHeader("https://web.push.apple.com/x", shortKey, Date.now())).not.toThrow();
  });

  it("always emits a 32-byte private key", () => {
    for (let i = 0; i < 300; i += 1) {
      expect(unb64u(generateVapidKeys().privateKey).length).toBe(32);
    }
  });
});
