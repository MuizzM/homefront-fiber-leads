// ── Web push (VAPID + RFC 8291), hand-rolled on node:crypto ─────────────────
//
// No `web-push` dependency. Not for purity — CI installs lockfile-exact, and
// everything this needs (ECDH P-256, HKDF, AES-128-GCM, ES256 signing) is in
// node:crypto already.
//
// ── WHAT A REP HAS TO DO FOR THIS TO WORK ON AN IPHONE ─────────────────────
//
// On iOS, web push ONLY works when the site has been ADDED TO THE HOME SCREEN
// and launched from that icon (Safari 16.4+). A rep browsing in Safari cannot
// receive a push no matter what we do here. That is not a limitation we can
// engineer around, and it is the entire reason the install prompt exists — the
// prompt is a prerequisite, not decoration.
//
// Android/Chrome will subscribe from an ordinary tab.
//
// ── THE TWO LAYERS ──────────────────────────────────────────────────────────
//
//   VAPID   proves to the push service WHO is sending. An ES256 JWT signed with
//           the server's private key, naming the push endpoint's origin as the
//           audience and expiring within 24h.
//   RFC 8291 encrypts the PAYLOAD so the push service (Apple, Google, Mozilla)
//           cannot read it. ECDH against the subscriber's public key, HKDF to
//           derive the content key, AES-128-GCM to seal.
//
// Neither is optional: without VAPID the service rejects the request, and
// without encryption we would be handing a rep's sale notifications to a third
// party in plaintext.

import {
  createECDH, createHmac, createCipheriv, createSign, createPrivateKey, randomBytes,
} from "node:crypto";

export interface PushSubscription {
  endpoint: string;
  /** Subscriber's public key, base64url (the `p256dh` key). */
  p256dh: string;
  /** Subscriber's auth secret, base64url. */
  auth: string;
}

export interface VapidKeys {
  publicKey: string;   // base64url, uncompressed P-256 point (65 bytes)
  privateKey: string;  // base64url, 32-byte scalar
  /** mailto: or https: contact, required by the spec and by Apple. */
  subject: string;
}

const b64url = (b: Buffer): string => b.toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromB64url = (s: string): Buffer =>
  Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** Generate a keypair. Run once; store the private key as a secret and ship the
 *  public key to the browser. Rotating it invalidates every subscription. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: b64url(ecdh.getPublicKey()),
    // PADDED. getPrivateKey() returns the scalar as a big-endian integer with
    // leading zero bytes STRIPPED, so roughly 1 key in 256 comes back as 31
    // bytes (measured: 19 of 3000). Storing a short key is silently fatal —
    // see pad32.
    privateKey: b64url(pad32(ecdh.getPrivateKey())),
  };
}

/** Left-pad a P-256 scalar to its full 32 bytes.
 *
 *  This is the whole bug. node strips leading zeros from the private scalar,
 *  and the PKCS#8 template below declares a fixed 32-byte OCTET STRING — so a
 *  31-byte key produces DER that OpenSSL rejects with
 *  "asn1 encoding routines: not enough data".
 *
 *  The failure mode is nasty because VAPID keys are generated ONCE and stored:
 *  an org unlucky enough to mint a short key would have every push fail forever,
 *  with an ASN.1 error nobody would connect to notifications not arriving.
 *  Caught by the 40-iteration loop in tests/unit/web-push.test.ts. */
function pad32(b: Buffer): Buffer {
  if (b.length === 32) return b;
  if (b.length > 32) return b.subarray(b.length - 32);
  return Buffer.concat([Buffer.alloc(32 - b.length), b]);
}

// ── HKDF (RFC 5869), the two-step form RFC 8291 uses ────────────────────────
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  const out = createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest();
  return out.subarray(0, length);
}

/** DER (what node's signer emits) → JOSE r||s (what JWT requires). */
function derToJose(der: Buffer): Buffer {
  // SEQUENCE { INTEGER r, INTEGER s } — lengths vary because DER strips leading
  // zeros and adds one back when the high bit is set, so neither half can be
  // read at a fixed offset.
  let offset = 2;
  if (der[1]! & 0x80) offset += der[1]! & 0x7f;   // long-form length
  const readInt = (): Buffer => {
    const len = der[offset + 1]!;
    let v = der.subarray(offset + 2, offset + 2 + len);
    offset += 2 + len;
    if (v.length > 32) v = v.subarray(v.length - 32);        // drop pad byte
    return Buffer.concat([Buffer.alloc(32 - v.length), v]);  // left-pad to 32
  };
  const r = readInt(), s = readInt();
  return Buffer.concat([r, s]);
}

/** A PKCS#8 key from the raw 32-byte scalar, so node's signer will take it. */
function privateKeyFromRaw(rawPrivate: Buffer, rawPublic: Buffer) {
  const der = Buffer.concat([
    Buffer.from("308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420", "hex"),
    // Padded here too, not just at generation: a key stored before this fix, or
    // pasted in from elsewhere, must still sign rather than throw.
    pad32(rawPrivate),
    Buffer.from("a144034200", "hex"),
    rawPublic,
  ]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/** The VAPID Authorization header for one endpoint. */
export function vapidHeader(endpoint: string, keys: VapidKeys, nowMs: number): string {
  const aud = new URL(endpoint).origin;
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  // 12h. The spec caps it at 24h; staying well under means a clock skewed by an
  // hour on either side still produces an acceptable token.
  const exp = Math.floor(nowMs / 1000) + 12 * 60 * 60;
  const body = b64url(Buffer.from(JSON.stringify({ aud, exp, sub: keys.subject })));
  const signingInput = `${header}.${body}`;

  const rawPrivate = fromB64url(keys.privateKey);
  const rawPublic = fromB64url(keys.publicKey);
  const signer = createSign("SHA256");
  signer.update(signingInput);
  const sig = b64url(derToJose(signer.sign(privateKeyFromRaw(rawPrivate, rawPublic))));

  return `vapid t=${signingInput}.${sig}, k=${keys.publicKey}`;
}

/**
 * Encrypt a payload for one subscriber (RFC 8291, aes128gcm).
 *
 * Returns the body to POST. The record is self-describing — salt, record size
 * and the server's ephemeral public key are in the header — so the browser can
 * decrypt it without any out-of-band agreement.
 */
export function encryptPayload(sub: PushSubscription, payload: string): Buffer {
  const clientPublic = fromB64url(sub.p256dh);
  const authSecret = fromB64url(sub.auth);

  // A FRESH ephemeral keypair per message. Reusing one would let anyone who
  // recovered a single message key read every message to that subscriber.
  const server = createECDH("prime256v1");
  server.generateKeys();
  const sharedSecret = server.computeSecret(clientPublic);
  const serverPublic = server.getPublicKey();

  // Pseudo-random key: binds the shared secret to BOTH parties' public keys, so
  // a swapped key produces a different PRK rather than a valid decryption.
  const prkInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"), clientPublic, serverPublic,
  ]);
  const ikm = hkdf(authSecret, sharedSecret, prkInfo, 32);

  const salt = randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 is the record delimiter for the LAST record. A single-record message
  // still needs it or the browser waits for a continuation that never comes.
  const body = Buffer.concat([Buffer.from(payload, "utf8"), Buffer.from([0x02])]);
  const sealed = Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096, 0);
  return Buffer.concat([
    salt, recordSize, Buffer.from([serverPublic.length]), serverPublic, sealed,
  ]);
}

export interface PushResult {
  ok: boolean;
  status: number;
  /** True when the subscription is dead and should be deleted. */
  gone: boolean;
}

/**
 * Send one push.
 *
 * `gone` is the important part of the result: push services return 404/410 for
 * a subscription that no longer exists (app deleted, permission revoked, device
 * wiped). Those MUST be pruned — a table of dead endpoints grows forever and
 * every send pays for them in latency.
 */
export async function sendPush(
  sub: PushSubscription, payload: string, keys: VapidKeys, nowMs: number, ttlSeconds = 900,
): Promise<PushResult> {
  try {
    const bodyBuf = encryptPayload(sub, payload);
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: vapidHeader(sub.endpoint, keys, nowMs),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        // A field notification is worthless an hour late — "Power Hour ends in
        // 10 minutes" delivered at 9pm is noise. Expire rather than queue.
        TTL: String(ttlSeconds),
        Urgency: "high",
      },
      body: bodyBuf as any,
    });
    return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
  } catch {
    // A network failure is NOT a dead subscription — returning gone:true here
    // would prune every device during a blip.
    return { ok: false, status: 0, gone: false };
  }
}
