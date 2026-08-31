// ── Tracerfy: skip trace + DNC scrub ────────────────────────────────────────
//
// Two calls, one shape each:
//
//   skipTraceLead(lead)  → { ownerName?, phones: LeadPhone[] }
//   scrubPhones(phones)  → { [e164]: { dnc, flags } }
//
// Both are async-queue APIs, not request/response: you submit a job, poll a
// queue id, then download a CSV. That is hidden behind the two functions above
// so callers never see a queue.
//
// ── ENDPOINTS ───────────────────────────────────────────────────────────────
//
//   POST /v1/api/trace/                start a skip-trace job
//   GET  /v1/api/queue/:id             trace status + result urls
//   POST /v1/api/dnc/scrub-from-queue/ scrub straight off a finished trace
//   POST /v2/api/dnc/scrub/            scrub an arbitrary phone list
//   GET  /v2/api/dnc/queue/:id         scrub status + result urls
//
// DNC is v2: it returns `state_dnc_list` (WHICH state registry matched, not
// merely that one did). v2 drops `dma` and `phone_type`, which costs us
// nothing — line type comes from the TRACE, and DMA is a mail-preference
// service we record but do not enforce (see shared/tracerfy.ts).
//
// We download `download_url`, NEVER `clean_download_url`. The clean file omits
// flagged numbers entirely, and a flagged number has to stay on the lead card:
// the rule is "don't dial", not "don't know".
//
// ── FAILING CLOSED ──────────────────────────────────────────────────────────
//
// Every phone this module returns carries `dnc: true` until a scrub says
// otherwise. A timeout, a truncated CSV, a phone missing from the results — all
// of them leave the number blocked rather than dialable. That is the whole
// safety posture: the expensive failure is a number that gets dialled because
// nobody checked, not one that sits undialled for a day.
import { setTimeout as delay } from "node:timers/promises";
import { isBlankCsvRow, parseCsvRows } from "./csv";
import { normalizeUsPhone } from "@shared/calling";
import type { DncFlags, LineType } from "@shared/tracerfy";

export interface LeadPhone {
  number: string;
  lineType?: LineType;
  confidence?: number;
  dnc: boolean;
  /** Which system decided. "tracerfy_dnc_v2" | "unscreened" | "scrub_failed". */
  dncSource?: string;
  dncFlags?: DncFlags;
  scrubbedAtMs?: number | null;
}

export interface SkipTraceInput {
  address: string;
  city: string;
  state: string;
  zip?: string;
  ownerName?: string | null;
}

export interface SkipTraceResult {
  ownerName?: string | null;
  phones: LeadPhone[];
}

export interface ScrubVerdict {
  dnc: boolean;
  flags?: DncFlags;
}

const BASE = (process.env.TRACERFY_BASE_URL || "https://api.tracerfy.com").replace(/\/+$/, "");
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 10 * 60_000;

/** Secret from the environment, never from the database or a config row. */
function apiKey(): string {
  const key = process.env.TRACERFY_API_KEY;
  if (!key) throw new Error("TRACERFY_API_KEY is not configured");
  return key;
}

async function api(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    // A redirect is a configuration error, not something to follow blindly to
    // an unchecked host.
    redirect: "manual",
    headers: {
      authorization: `Bearer ${apiKey()}`,
      accept: "application/json",
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`Tracerfy ${path} → HTTP ${res.status}`);
  return res.json();
}

/** Poll a queue until it reports completion. Returns the final payload.
 *
 *  `phones_checked` / `phones_clean` / `credits_deducted` are absent while a
 *  job is pending, so their PRESENCE is the completion signal alongside an
 *  explicit status — belt and braces, because a half-written payload read as
 *  "done" would silently produce an empty result set. */
async function pollQueue(path: string, nowMs: () => number): Promise<any> {
  const deadline = nowMs() + POLL_TIMEOUT_MS;
  for (;;) {
    const body = await api(path);
    const status = String(body?.status ?? "").toLowerCase();
    if (status === "complete" || status === "completed" || body?.download_url) return body;
    if (status === "failed" || status === "error") {
      throw new Error(`Tracerfy job failed: ${body?.error ?? "unknown"}`);
    }
    if (nowMs() >= deadline) throw new Error(`Tracerfy job timed out after ${POLL_TIMEOUT_MS}ms`);
    await delay(POLL_INTERVAL_MS);
  }
}

/** Minimal RFC-4180 CSV → row objects. Handles quoted fields containing commas
 *  and escaped quotes, which owner names ("Smith, John Jr.") routinely do.
 *
 *  Header adapter over the shared tokenizer (./csv) — this file's state machine
 *  WAS that tokenizer, so nothing about the parse changed. Blank rows are
 *  dropped before the header is taken (their exports end with stray newlines),
 *  and both headers and values are trimmed: a provider writes ", Mobile" and a
 *  space must not become part of a phone number. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const [header, ...body] = parseCsvRows(text).filter(r => !isBlankCsvRow(r));
  if (!header) return [];
  return body.map(r => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => { o[h.trim()] = (r[i] ?? "").trim(); });
    return o;
  });
}

const truthy = (v: string | undefined): boolean =>
  v != null && ["true", "1", "yes", "y", "t"].includes(v.trim().toLowerCase());

function lineTypeOf(raw: string | undefined): LineType {
  const v = (raw ?? "").trim().toLowerCase();
  if (v.startsWith("mobile") || v.startsWith("wireless") || v.startsWith("cell")) return "wireless";
  if (v.startsWith("land")) return "landline";
  if (v.includes("voip")) return "voip";
  return "unknown";
}

async function downloadCsv(url: string): Promise<Array<Record<string, string>>> {
  const res = await fetch(url, { redirect: "manual" });
  if (!res.ok) throw new Error(`Tracerfy result download → HTTP ${res.status}`);
  return parseCsv(await res.text());
}

/**
 * Skip-trace one property.
 *
 * `trace_type: "advanced"` is not optional for us: the pilot ran a batch as
 * "normal" and scored 0%, because `normal` matches on a NAME we do not have.
 * Address-only lists must use `advanced`.
 *
 * Every phone comes back `dnc: true` / `dncSource: "unscreened"`. Tracing tells
 * us a number exists; it says nothing about whether it may be dialled, and the
 * caller must run scrubPhones() before anything reaches a queue.
 */
export async function skipTraceLead(
  lead: SkipTraceInput,
  opts: { nowMs?: () => number } = {},
): Promise<SkipTraceResult> {
  const now = opts.nowMs ?? Date.now;
  const started = await api("/v1/api/trace/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      trace_type: "advanced",
      records: [{
        mail_address: lead.address,
        city: lead.city,
        state: lead.state,
        zip: lead.zip ?? "",
        first_name: "",
        last_name: "",
      }],
    }),
  });

  const queueId = started?.queue_id ?? started?.id;
  if (!queueId) throw new Error("Tracerfy trace returned no queue id");
  const done = await pollQueue(`/v1/api/queue/${encodeURIComponent(String(queueId))}`, now);
  if (!done?.download_url) return { ownerName: lead.ownerName ?? null, phones: [] };

  const rows = await downloadCsv(done.download_url);
  const first = rows[0];
  const ownerName = [first?.owner_name, first?.first_name && first?.last_name
    ? `${first.first_name} ${first.last_name}` : null].find(v => (v ?? "").trim().length > 1)
    ?? lead.ownerName ?? null;

  // Providers spread phones across numbered columns (phone1, phone2, …) with a
  // matching type/score column. Collect every populated slot rather than
  // assuming a fixed count.
  const phones: LeadPhone[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (!/^phone[_ ]?\d*$/i.test(key) || !value) continue;
      const e164 = normalizeUsPhone(value);
      if (!e164 || seen.has(e164)) continue;
      seen.add(e164);
      const idx = key.replace(/\D/g, "");
      const score = Number(row[`phone${idx}_score`] ?? row[`phone_score`] ?? "");
      phones.push({
        number: e164,
        lineType: lineTypeOf(row[`phone${idx}_type`] ?? row.phone_type),
        confidence: Number.isFinite(score) ? Math.max(0, Math.min(1, score > 1 ? score / 100 : score)) : 0.5,
        dnc: true,                      // fails closed until scrubbed
        dncSource: "unscreened",
        scrubbedAtMs: null,
      });
    }
  }
  return { ownerName, phones };
}

/** Address key used to match a result row back to the lead that produced it.
 *  Case/punctuation/whitespace-insensitive, because the provider echoes a
 *  normalized form of what we sent rather than the exact string. */
function addressKey(address: string, zip: string | undefined): string {
  return `${address} ${zip ?? ""}`.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export interface BatchSkipTraceLead extends SkipTraceInput {
  leadId: number;
}

export interface BatchSkipTraceResult {
  /** The trace queue, so the caller can scrubFromQueue() instead of
   *  re-uploading every number it just received. */
  traceQueueId: string;
  byLeadId: Map<number, SkipTraceResult>;
}

/**
 * Skip-trace MANY properties in one job.
 *
 * The API takes `records[]`, and an area is 100–250 doors. Tracing them one at
 * a time means one queued job per door, each polled to completion — hours of
 * wall clock and a separate job per address, when the provider is built to
 * take the whole list at once. Same endpoint, same `trace_type: "advanced"`,
 * same CSV; only the batching differs.
 *
 * Rows are matched back to leads by ADDRESS, not by a custom id column: the
 * pilot found the results CSV can drop custom columns, which is the same
 * lesson that produced scrubFromQueue. An unmatched row is discarded rather
 * than guessed at — attaching a stranger's phone number to a door is far worse
 * than returning none.
 */
export async function skipTraceLeads(
  leads: BatchSkipTraceLead[],
  opts: { nowMs?: () => number } = {},
): Promise<BatchSkipTraceResult> {
  const now = opts.nowMs ?? Date.now;
  const byLeadId = new Map<number, SkipTraceResult>();
  for (const lead of leads) byLeadId.set(lead.leadId, { ownerName: lead.ownerName ?? null, phones: [] });
  if (leads.length === 0) return { traceQueueId: "", byLeadId };

  const started = await api("/v1/api/trace/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      trace_type: "advanced",
      records: leads.map(lead => ({
        mail_address: lead.address,
        city: lead.city,
        state: lead.state,
        zip: lead.zip ?? "",
        first_name: "",
        last_name: "",
      })),
    }),
  });
  const traceQueueId = String(started?.queue_id ?? started?.id ?? "");
  if (!traceQueueId) throw new Error("Tracerfy trace returned no queue id");

  const done = await pollQueue(`/v1/api/queue/${encodeURIComponent(traceQueueId)}`, now);
  if (!done?.download_url) return { traceQueueId, byLeadId };

  // Index the leads by address so each row lands on the right door.
  const leadByAddress = new Map<string, BatchSkipTraceLead>();
  for (const lead of leads) leadByAddress.set(addressKey(lead.address, lead.zip), lead);

  const seenPerLead = new Map<number, Set<string>>();
  for (const row of await downloadCsv(done.download_url)) {
    const lead = leadByAddress.get(addressKey(row.mail_address ?? row.address ?? "", row.zip));
    if (!lead) continue;
    const result = byLeadId.get(lead.leadId)!;
    const traced = [row.owner_name, row.first_name && row.last_name
      ? `${row.first_name} ${row.last_name}` : null].find(v => (v ?? "").trim().length > 1);
    if (traced && !(result.ownerName ?? "").trim()) result.ownerName = traced;

    let seen = seenPerLead.get(lead.leadId);
    if (!seen) { seen = new Set<string>(); seenPerLead.set(lead.leadId, seen); }
    for (const [key, value] of Object.entries(row)) {
      if (!/^phone[_ ]?\d*$/i.test(key) || !value) continue;
      const e164 = normalizeUsPhone(value);
      if (!e164 || seen.has(e164)) continue;
      seen.add(e164);
      const idx = key.replace(/\D/g, "");
      const score = Number(row[`phone${idx}_score`] ?? row[`phone_score`] ?? "");
      result.phones.push({
        number: e164,
        lineType: lineTypeOf(row[`phone${idx}_type`] ?? row.phone_type),
        confidence: Number.isFinite(score) ? Math.max(0, Math.min(1, score > 1 ? score / 100 : score)) : 0.5,
        dnc: true,                      // fails closed until scrubbed
        dncSource: "unscreened",
        scrubbedAtMs: null,
      });
    }
  }
  return { traceQueueId, byLeadId };
}

/**
 * DNC-scrub a list of numbers.
 *
 * Returns a verdict for EVERY input number. A number the provider omitted from
 * its results stays `dnc: true` — silence is not a clearance.
 */
export async function scrubPhones(
  phones: string[],
  opts: { nowMs?: () => number } = {},
): Promise<Record<string, ScrubVerdict>> {
  const now = opts.nowMs ?? Date.now;
  const unique = Array.from(new Set(phones.map(p => normalizeUsPhone(p)).filter(Boolean) as string[]));
  // Start from "blocked" for every number, then relax the ones the scrub clears.
  const out: Record<string, ScrubVerdict> = {};
  for (const p of unique) out[p] = { dnc: true };
  if (unique.length === 0) return out;

  const started = await api("/v2/api/dnc/scrub/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phones: unique }),
  });
  const queueId = started?.queue_id ?? started?.id;
  if (!queueId) throw new Error("Tracerfy scrub returned no queue id");

  const done = await pollQueue(`/v2/api/dnc/queue/${encodeURIComponent(String(queueId))}`, now);
  // ALL phones, not clean_download_url — blocked numbers must stay on the card.
  if (!done?.download_url) return out;

  for (const row of await downloadCsv(done.download_url)) {
    const e164 = normalizeUsPhone(row.phone ?? "");
    if (!e164 || !(e164 in out)) continue;
    const flags: DncFlags = {
      federalDnc: truthy(row.national_dnc),
      stateDnc: truthy(row.state_dnc),
      dma: truthy(row.dma),                    // v1 only; absent on v2
      tcpaLitigator: truthy(row.litigator),
    };
    // `is_clean` is the provider's own summary. Trust our own OR of the flags
    // when they disagree — a provider that adds a new flag type we do not read
    // must not be able to widen what we consider dialable.
    const blocked = flags.federalDnc || flags.stateDnc || flags.tcpaLitigator;
    out[e164] = { dnc: blocked || !truthy(row.is_clean), flags };
  }
  return out;
}

/** Trace results already sitting in a Tracerfy queue, scrubbed without a second
 *  upload. Cheaper and avoids the address round-trip the pilot hit when the
 *  results CSV dropped the custom id column. */
export async function scrubFromQueue(
  traceQueueId: string,
  opts: { nowMs?: () => number } = {},
): Promise<Record<string, ScrubVerdict>> {
  const now = opts.nowMs ?? Date.now;
  const started = await api("/v1/api/dnc/scrub-from-queue/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ queue_id: traceQueueId }),
  });
  const queueId = started?.queue_id ?? started?.id;
  if (!queueId) throw new Error("Tracerfy scrub-from-queue returned no queue id");
  const done = await pollQueue(`/v2/api/dnc/queue/${encodeURIComponent(String(queueId))}`, now);
  const out: Record<string, ScrubVerdict> = {};
  if (!done?.download_url) return out;
  for (const row of await downloadCsv(done.download_url)) {
    const e164 = normalizeUsPhone(row.phone ?? "");
    if (!e164) continue;
    const flags: DncFlags = {
      federalDnc: truthy(row.national_dnc),
      stateDnc: truthy(row.state_dnc),
      dma: truthy(row.dma),
      tcpaLitigator: truthy(row.litigator),
    };
    const blocked = flags.federalDnc || flags.stateDnc || flags.tcpaLitigator;
    out[e164] = { dnc: blocked || !truthy(row.is_clean), flags };
  }
  return out;
}

/** Merge scrub verdicts onto traced phones. Anything the scrub did not answer
 *  for stays blocked and is marked so the UI can say WHY. */
export function applyScrub(
  phones: LeadPhone[],
  verdicts: Record<string, ScrubVerdict>,
  nowMs: number,
): LeadPhone[] {
  return phones.map(p => {
    const v = verdicts[p.number];
    if (!v) return { ...p, dnc: true, dncSource: "scrub_failed", scrubbedAtMs: null };
    return {
      ...p,
      dnc: v.dnc,
      dncFlags: v.flags,
      dncSource: "tracerfy_dnc_v2",
      scrubbedAtMs: nowMs,
    };
  });
}
