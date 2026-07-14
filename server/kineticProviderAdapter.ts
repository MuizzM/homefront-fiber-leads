import crypto from "node:crypto";
import { z } from "zod";

export type KineticLookupKey =
  | { sequentialId: number; kineticAddressId?: never }
  | { kineticAddressId: string; sequentialId?: never };

export interface NormalizedKineticAddress {
  kineticAddressId: string | null;
  sequentialId: number | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  latitude: number | null;
  longitude: number | null;
  exchangeId: string | null;
  technologyType: string | null;
  maximumQualification: number | null;
  estimatedCompletionDate: string | null;
  isLive: boolean | null;
  isComingSoon: boolean | null;
  isCopperUpgradeCandidate: boolean | null;
  rawResponse: unknown;
  responseHash: string;
}

export interface KineticProviderAdapter {
  readonly name: string;
  ping(signal?: AbortSignal): Promise<{ ok: boolean; latencyMs: number; message: string }>;
  healthCheck(signal?: AbortSignal): Promise<{ ok: boolean; latencyMs: number; message: string }>;
  searchAddresses(input: KineticAddressSearchInput, signal?: AbortSignal): Promise<NormalizedKineticAddress[]>;
  qualifyAddress(key: KineticLookupKey, signal?: AbortSignal): Promise<NormalizedKineticAddress | null>;
  lookup(key: KineticLookupKey, signal?: AbortSignal): Promise<NormalizedKineticAddress | null>;
}

export const kineticAddressSearchSchema=z.object({
  address:z.string().trim().min(3).max(160),city:z.string().trim().min(1).max(100),state:z.string().trim().length(2).transform(value=>value.toUpperCase()),zip:z.string().trim().regex(/^\d{5}(?:-\d{4})?$/).optional(),limit:z.number().int().min(1).max(50).default(10),
}).strict();
export type KineticAddressSearchInput=z.infer<typeof kineticAddressSearchSchema>;

const mappingSchema = z.object({
  root: z.string().default(""),
  kineticAddressId: z.string().default("kineticAddressId"),
  sequentialId: z.string().default("sequentialId"),
  address: z.string().default("address"),
  city: z.string().default("city"),
  state: z.string().default("state"),
  zip: z.string().default("zip"),
  latitude: z.string().default("latitude"),
  longitude: z.string().default("longitude"),
  exchangeId: z.string().default("exchangeId"),
  technologyType: z.string().default("techType"),
  maximumQualification: z.string().default("maxQual"),
  estimatedCompletionDate: z.string().default("estimatedCompletionDate"),
  isLive: z.string().default("isLive"),
  isComingSoon: z.string().default("isComingSoon"),
  isCopperUpgradeCandidate: z.string().default("copperUpgradeCandidate"),
}).strict();

type Mapping = z.infer<typeof mappingSchema>;

function readPath(input: unknown, path: string): unknown {
  if (!path) return input;
  return path.split(".").reduce<unknown>((value, part) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[part];
  }, input);
}

function text(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function integer(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function finite(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function directBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return null;
}

function stableHash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}

export function normalizeKineticResponse(rawResponse: unknown, mappingInput?: Partial<Mapping>): NormalizedKineticAddress {
  const mapping = mappingSchema.parse(mappingInput ?? {});
  const root = readPath(rawResponse, mapping.root);
  return {
    kineticAddressId: text(readPath(root, mapping.kineticAddressId)),
    sequentialId: integer(readPath(root, mapping.sequentialId)),
    address: text(readPath(root, mapping.address)),
    city: text(readPath(root, mapping.city)),
    state: text(readPath(root, mapping.state))?.toUpperCase() ?? null,
    zip: text(readPath(root, mapping.zip)),
    latitude: finite(readPath(root, mapping.latitude)),
    longitude: finite(readPath(root, mapping.longitude)),
    exchangeId: text(readPath(root, mapping.exchangeId)),
    technologyType: text(readPath(root, mapping.technologyType)),
    maximumQualification: finite(readPath(root, mapping.maximumQualification)),
    estimatedCompletionDate: text(readPath(root, mapping.estimatedCompletionDate)),
    isLive: directBoolean(readPath(root, mapping.isLive)),
    isComingSoon: directBoolean(readPath(root, mapping.isComingSoon)),
    isCopperUpgradeCandidate: directBoolean(readPath(root, mapping.isCopperUpgradeCandidate)),
    rawResponse,
    responseHash: stableHash(rawResponse),
  };
}

function configuredMapping(): Mapping {
  if (!process.env.KINETIC_RESPONSE_MAPPING_JSON) return mappingSchema.parse({});
  try {
    return mappingSchema.parse(JSON.parse(process.env.KINETIC_RESPONSE_MAPPING_JSON));
  } catch (error) {
    throw new Error(`KINETIC_RESPONSE_MAPPING_JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function normalizeConfiguredKineticResponse(rawResponse: unknown): NormalizedKineticAddress {
  return normalizeKineticResponse(rawResponse, configuredMapping());
}

function endpointFor(key: KineticLookupKey): string {
  const template = "sequentialId" in key
    ? process.env.KINETIC_SEQUENTIAL_ENDPOINT
    : process.env.KINETIC_ADDRESS_ENDPOINT;
  if (!template) throw new Error("Kinetic provider endpoint is not configured");
  const encoded = encodeURIComponent(String("sequentialId" in key ? key.sequentialId : key.kineticAddressId));
  return template.replace("{id}", encoded).replace("{sequentialId}", encoded).replace("{kineticAddressId}", encoded);
}

function headers(): Record<string, string> {
  const result: Record<string, string> = { Accept: "application/json" };
  if (process.env.KINETIC_API_KEY) result[process.env.KINETIC_API_KEY_HEADER || "Authorization"] =
    process.env.KINETIC_API_KEY_HEADER ? process.env.KINETIC_API_KEY : `Bearer ${process.env.KINETIC_API_KEY}`;
  return result;
}

export class HttpKineticProviderAdapter implements KineticProviderAdapter {
  readonly name = "kinetic-authorized-http";
  private readonly mapping = configuredMapping();

  async ping(signal?: AbortSignal): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    const started = performance.now();
    const url = process.env.KINETIC_PING_ENDPOINT || process.env.KINETIC_SEQUENTIAL_ENDPOINT;
    if (!url) return { ok: false, latencyMs: 0, message: "Kinetic provider endpoint is not configured" };
    try {
      const response = await fetch(url.replace("{id}", "1").replace("{sequentialId}", "1"), { method: "HEAD", headers: headers(), signal });
      return { ok: response.ok || response.status === 405, latencyMs: Math.round(performance.now() - started), message: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, latencyMs: Math.round(performance.now() - started), message: error instanceof Error ? error.message : String(error) };
    }
  }

  healthCheck(signal?:AbortSignal):Promise<{ok:boolean;latencyMs:number;message:string}>{return this.ping(signal);}

  async searchAddresses(input:KineticAddressSearchInput,signal?:AbortSignal):Promise<NormalizedKineticAddress[]>{
    const parsed=kineticAddressSearchSchema.parse(input),url=process.env.KINETIC_SEARCH_ENDPOINT;
    if(!url)throw new Error("Kinetic address-search endpoint is not configured");
    const method=(process.env.KINETIC_SEARCH_METHOD||"POST").toUpperCase();
    const requestUrl=method==="GET"?`${url}${url.includes("?")?"&":"?"}${new URLSearchParams({address:parsed.address,city:parsed.city,state:parsed.state,...(parsed.zip?{zip:parsed.zip}:{}),limit:String(parsed.limit)})}`:url;
    const response=await fetch(requestUrl,{method,headers:{...headers(),...(method==="GET"?{}:{"Content-Type":"application/json"})},body:method==="GET"?undefined:JSON.stringify(parsed),signal});
    if(!response.ok)throw new Error(`Kinetic address search returned HTTP ${response.status}`);
    const raw=await response.json(),rootPath=process.env.KINETIC_SEARCH_RESULTS_PATH||"results",root=readPath(raw,rootPath);
    if(!Array.isArray(root))throw new Error(`Kinetic address search response is missing array path ${rootPath}`);
    return root.slice(0,parsed.limit).map(item=>normalizeKineticResponse(item,this.mapping));
  }

  qualifyAddress(key:KineticLookupKey,signal?:AbortSignal):Promise<NormalizedKineticAddress|null>{return this.lookup(key,signal);}

  async lookup(key: KineticLookupKey, signal?: AbortSignal): Promise<NormalizedKineticAddress | null> {
    const url = endpointFor(key);
    const field = "sequentialId" in key ? (process.env.KINETIC_SEQUENTIAL_REQUEST_FIELD || "sequentialId") : (process.env.KINETIC_ADDRESS_REQUEST_FIELD || "kineticAddressId");
    const value = "sequentialId" in key ? key.sequentialId : key.kineticAddressId;
    const method = (process.env.KINETIC_PROVIDER_METHOD || "POST").toUpperCase();
    const response = await fetch(url, {
      method,
      headers: { ...headers(), ...(method === "GET" ? {} : { "Content-Type": "application/json" }) },
      body: method === "GET" ? undefined : JSON.stringify({ [field]: value }),
      signal,
    });
    if (response.status === 404 || response.status === 204) return null;
    if (!response.ok) throw new Error(`Kinetic provider returned HTTP ${response.status}`);
    const raw = await response.json();
    const normalized = normalizeKineticResponse(raw, this.mapping);
    if ("sequentialId" in key && normalized.sequentialId == null) normalized.sequentialId = key.sequentialId ?? null;
    if ("kineticAddressId" in key && normalized.kineticAddressId == null) normalized.kineticAddressId = key.kineticAddressId ?? null;
    return normalized;
  }
}

let adapter: KineticProviderAdapter = new HttpKineticProviderAdapter();
export function getKineticProviderAdapter(): KineticProviderAdapter { return adapter; }
export function setKineticProviderAdapterForTest(value: KineticProviderAdapter): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Kinetic provider overrides are test-only");
  adapter = value;
}
