import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

// Minimal CBOR encoder for synthetic ES256 authenticator fixtures. Production
// parsing/verification uses SimpleWebAuthn; fixtures use real Node signatures.
function cbor(value: string | number | Buffer | Map<unknown, unknown>): Buffer {
  const head = (major: number, n: number) => n < 24 ? Buffer.from([(major << 5) | n])
    : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") { const bytes = Buffer.from(value); return Buffer.concat([head(3, bytes.length), bytes]); }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  return Buffer.concat([head(5, value.size), ...Array.from(value, ([key, entry]) => Buffer.concat([cbor(key as any), cbor(entry as any)]))]);
}
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest();
export function softwareAuthenticator() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const credentialId = randomBytes(32), id = credentialId.toString("base64url");
  const key = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
  const authData = (rpId: string, flags: number, counter: number) => {
    const count = Buffer.alloc(4); count.writeUInt32BE(counter);
    return Buffer.concat([digest(rpId), Buffer.from([flags]), count]);
  };
  return {
    id,
    registration(challenge: string, origin = "https://portal.example.test", rpId = "portal.example.test", uv = true, crossOrigin = false): RegistrationResponseJSON {
      const length = Buffer.alloc(2); length.writeUInt16BE(credentialId.length);
      const data = Buffer.concat([authData(rpId, uv ? 0x45 : 0x41, 0), Buffer.alloc(16), length, credentialId, key]);
      const client = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin }));
      return { id, rawId: id, type: "public-key", clientExtensionResults: {}, response: {
        clientDataJSON: client.toString("base64url"), attestationObject: cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", data]])).toString("base64url"),
        transports: ["internal"],
      } };
    },
    authentication(challenge: string, counter: number, origin = "https://portal.example.test", rpId = "portal.example.test", uv = true, crossOrigin = false): AuthenticationResponseJSON {
      const client = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin }));
      const data = authData(rpId, uv ? 0x05 : 0x01, counter);
      return { id, rawId: id, type: "public-key", clientExtensionResults: {}, response: {
        clientDataJSON: client.toString("base64url"), authenticatorData: data.toString("base64url"),
        signature: sign("sha256", Buffer.concat([data, digest(client)]), privateKey).toString("base64url"),
      } };
    },
  };
}
