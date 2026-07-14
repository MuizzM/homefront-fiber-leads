import crypto from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalDncImportManifest, type DncImportManifest } from "../server/calling/crypto";
import { normalizeUsPhone } from "../shared/calling";

function signingKey(): Buffer {
  const raw = process.env.DNC_IMPORT_MANIFEST_SIGNING_KEY?.trim();
  if (!raw) throw new Error("DNC_IMPORT_MANIFEST_SIGNING_KEY is required");
  const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("DNC_IMPORT_MANIFEST_SIGNING_KEY must decode to 32 bytes");
  return key;
}

const [, , configPath, phonePath, outputPath] = process.argv;
if (!configPath || !phonePath || !outputPath) {
  throw new Error("Usage: npm run calling:dnc:sign -- <config.json> <phones.txt> <signed-manifest.json>");
}

const config = JSON.parse(readFileSync(resolve(configPath), "utf8")) as Partial<DncImportManifest>;
const chunkSize = Number(config.chunkSize ?? 3_000);
if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 3_000) throw new Error("chunkSize must be 1..3000");
const phoneLines = readFileSync(resolve(phonePath), "utf8").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
if (!phoneLines.length) throw new Error("Phone export is empty");
const chunks: string[][] = [];
for (let index = 0; index < phoneLines.length; index += chunkSize) chunks.push(phoneLines.slice(index, index + chunkSize));
const normalizedUnique = new Set<string>();
const descriptions = chunks.map((chunk, chunkIndex) => {
  const normalized = [...new Set(chunk.map(normalizeUsPhone).filter((value): value is string => Boolean(value)))].sort();
  if (!normalized.length) throw new Error(`Chunk ${chunkIndex} contains no valid US phone numbers`);
  normalized.forEach((phone) => normalizedUnique.add(phone));
  const sourceChunkSha256 = crypto.createHash("sha256").update(normalized.join("\n")).digest("hex");
  return `${chunkIndex}:${sourceChunkSha256}:${chunk.length}:${normalized.length}`;
});

const sourceAsOf = new Date(String(config.sourceAsOf)).toISOString();
const sourceRetrievedAt = new Date(String(config.sourceRetrievedAt)).toISOString();
if (Date.parse(sourceRetrievedAt) < Date.parse(sourceAsOf)) throw new Error("sourceRetrievedAt cannot predate sourceAsOf");
const sourceManifestSha256 = crypto.createHash("sha256").update(descriptions.join("\n")).digest("hex");
const manifest: DncImportManifest = {
  tenantId: Number(config.tenantId),
  sourceType: config.sourceType === "state" ? "state" : "national",
  state: config.sourceType === "state" ? String(config.state ?? "").toUpperCase() : null,
  versionLabel: String(config.versionLabel ?? ""),
  authorizedAccountRef: String(config.authorizedAccountRef ?? ""),
  coveredAreaCodes: Array.isArray(config.coveredAreaCodes) ? config.coveredAreaCodes.map(String) : [],
  expectedRecordCount: normalizedUnique.size,
  expectedChunkCount: chunks.length,
  chunkSize,
  sourceManifestSha256,
  sourceAsOf,
  sourceRetrievedAt,
  maxAgeDays: Number(config.maxAgeDays ?? 31),
};
if (!Number.isSafeInteger(manifest.tenantId) || manifest.tenantId < 1 || !manifest.versionLabel
    || !manifest.authorizedAccountRef || !manifest.coveredAreaCodes.includes("ALL")
    || (manifest.sourceType === "state" && !/^[A-Z]{2}$/.test(manifest.state ?? ""))) {
  throw new Error("Config must include tenantId, versionLabel, authorizedAccountRef, ALL coverage, and a state for state datasets");
}
const manifestSignature = crypto.createHmac("sha256", signingKey())
  .update(canonicalDncImportManifest(manifest)).digest("hex");
writeFileSync(resolve(outputPath), `${JSON.stringify({ ...manifest, manifestSignature }, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`Signed ${normalizedUnique.size} unique suppressions in ${chunks.length} chunks to ${resolve(outputPath)}\n`);
