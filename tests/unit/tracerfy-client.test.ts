// Tracerfy client — wire format and fail-closed behaviour.
//
// fetch is stubbed, so these assert the two things that actually break in
// production: whether we parse their CSV correctly, and whether a number can
// ever come out dialable when we did not prove it was.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCsv, skipTraceLead, scrubPhones, applyScrub, type LeadPhone } from "../../server/tracerfyClient";

const NOW = Date.UTC(2026, 7, 4, 12, 0, 0);
let calls: Array<{ url: string; body?: any }> = [];

/** Route stubbed responses by URL fragment. */
function stubFetch(routes: Record<string, any>) {
  vi.stubGlobal("fetch", vi.fn(async (url: any, init: any = {}) => {
    const u = String(url);
    calls.push({ url: u, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(routes).find(k => u.includes(k));
    if (!key) throw new Error(`unstubbed fetch: ${u}`);
    const r = routes[key];
    if (typeof r === "string") return { ok: true, status: 200, text: async () => r };
    return { ok: true, status: 200, json: async () => r, text: async () => JSON.stringify(r) };
  }));
}

beforeEach(() => { calls = []; process.env.TRACERFY_API_KEY = "test-key"; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("CSV parsing - their results are files, not JSON", () => {
  it("handles quoted fields containing commas", () => {
    // Owner names do this constantly: "Smith, John Jr."
    const rows = parseCsv('phone,owner_name\n+15551230001,"Smith, John Jr."\n');
    expect(rows[0]).toEqual({ phone: "+15551230001", owner_name: "Smith, John Jr." });
  });

  it("handles escaped quotes and CRLF", () => {
    const rows = parseCsv('a,b\r\n"say ""hi""",2\r\n');
    expect(rows[0]).toEqual({ a: 'say "hi"', b: "2" });
  });

  it("ignores trailing blank lines rather than emitting an empty row", () => {
    expect(parseCsv("phone\n+15551230001\n\n\n")).toHaveLength(1);
  });

  it("returns nothing for an empty file", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

describe("skipTraceLead", () => {
  const lead = { address: "1408 Winecoff School Rd", city: "Concord", state: "NC", zip: "28027" };

  it("uses trace_type=advanced - 'normal' scored 0% on address-only lists", () => {
    stubFetch({
      "/v1/api/trace/": { queue_id: "q1" },
      "/v1/api/queue/q1": { status: "complete", download_url: "https://dl/x.csv" },
      "dl/x.csv": "phone1,phone1_type,owner_name\n7045550142,Mobile,Dana Whitfield\n",
    });
    return skipTraceLead(lead, { nowMs: () => NOW }).then(() => {
      expect(calls[0]!.body.trace_type).toBe("advanced");
    });
  });

  it("returns the owner name and normalizes phones to E.164", async () => {
    stubFetch({
      "/v1/api/trace/": { queue_id: "q1" },
      "/v1/api/queue/q1": { status: "complete", download_url: "https://dl/x.csv" },
      "dl/x.csv": "phone1,phone1_type,phone2,phone2_type,owner_name\n(704) 555-0142,Mobile,704-555-0198,Landline,Dana Whitfield\n",
    });
    const out = await skipTraceLead(lead, { nowMs: () => NOW });
    expect(out.ownerName).toBe("Dana Whitfield");
    expect(out.phones.map(p => p.number)).toEqual(["+17045550142", "+17045550198"]);
    expect(out.phones[0]!.lineType).toBe("wireless");
    expect(out.phones[1]!.lineType).toBe("landline");
  });

  it("marks every traced phone BLOCKED until a scrub runs", async () => {
    // A trace proves a number exists. It says nothing about dialability.
    stubFetch({
      "/v1/api/trace/": { queue_id: "q1" },
      "/v1/api/queue/q1": { status: "complete", download_url: "https://dl/x.csv" },
      "dl/x.csv": "phone1,owner_name\n7045550142,Dana Whitfield\n",
    });
    const out = await skipTraceLead(lead, { nowMs: () => NOW });
    expect(out.phones[0]!.dnc).toBe(true);
    expect(out.phones[0]!.dncSource).toBe("unscreened");
    expect(out.phones[0]!.scrubbedAtMs).toBeNull();
  });

  it("de-duplicates a number that appears in two columns", async () => {
    stubFetch({
      "/v1/api/trace/": { queue_id: "q1" },
      "/v1/api/queue/q1": { status: "complete", download_url: "https://dl/x.csv" },
      "dl/x.csv": "phone1,phone2\n7045550142,(704) 555-0142\n",
    });
    expect((await skipTraceLead(lead, { nowMs: () => NOW })).phones).toHaveLength(1);
  });

  it("keeps the existing name when the trace returns none", async () => {
    stubFetch({
      "/v1/api/trace/": { queue_id: "q1" },
      "/v1/api/queue/q1": { status: "complete", download_url: "https://dl/x.csv" },
      "dl/x.csv": "phone1\n7045550142\n",
    });
    const out = await skipTraceLead({ ...lead, ownerName: "Existing Name" }, { nowMs: () => NOW });
    expect(out.ownerName).toBe("Existing Name");
  });

  it("throws rather than returning empty when the job fails", async () => {
    stubFetch({
      "/v1/api/trace/": { queue_id: "q1" },
      "/v1/api/queue/q1": { status: "failed", error: "insufficient credits" },
    });
    await expect(skipTraceLead(lead, { nowMs: () => NOW })).rejects.toThrow(/insufficient credits/);
  });
});

describe("scrubPhones - the part that decides what may be dialled", () => {
  it("clears a number with no flags", async () => {
    stubFetch({
      "/v2/api/dnc/scrub/": { queue_id: "s1" },
      "/v2/api/dnc/queue/s1": { status: "complete", download_url: "https://dl/s.csv" },
      "dl/s.csv": "phone,national_dnc,state_dnc,litigator,is_clean\n+17045550142,false,false,false,true\n",
    });
    const out = await scrubPhones(["+17045550142"], { nowMs: () => NOW });
    expect(out["+17045550142"]!.dnc).toBe(false);
  });

  it("blocks on each flag independently", async () => {
    stubFetch({
      "/v2/api/dnc/scrub/": { queue_id: "s1" },
      "/v2/api/dnc/queue/s1": { status: "complete", download_url: "https://dl/s.csv" },
      "dl/s.csv": [
        "phone,national_dnc,state_dnc,litigator,is_clean",
        "+17045550001,true,false,false,false",
        "+17045550002,false,true,false,false",
        "+17045550003,false,false,true,false",
      ].join("\n"),
    });
    const out = await scrubPhones(["+17045550001", "+17045550002", "+17045550003"], { nowMs: () => NOW });
    expect(Object.values(out).every(v => v.dnc)).toBe(true);
  });

  it("keeps a number BLOCKED when the results omit it", async () => {
    // Silence is not a clearance. This is the realistic partial-result case.
    stubFetch({
      "/v2/api/dnc/scrub/": { queue_id: "s1" },
      "/v2/api/dnc/queue/s1": { status: "complete", download_url: "https://dl/s.csv" },
      "dl/s.csv": "phone,national_dnc,state_dnc,litigator,is_clean\n+17045550001,false,false,false,true\n",
    });
    const out = await scrubPhones(["+17045550001", "+17045559999"], { nowMs: () => NOW });
    expect(out["+17045550001"]!.dnc).toBe(false);
    expect(out["+17045559999"]!.dnc).toBe(true);   // never answered for
  });

  it("does not let is_clean=true override a raised flag", async () => {
    // If the provider's summary disagrees with its own flags, trust the flags —
    // a new flag type we don't read must not widen what we consider dialable.
    stubFetch({
      "/v2/api/dnc/scrub/": { queue_id: "s1" },
      "/v2/api/dnc/queue/s1": { status: "complete", download_url: "https://dl/s.csv" },
      "dl/s.csv": "phone,national_dnc,state_dnc,litigator,is_clean\n+17045550001,true,false,false,true\n",
    });
    expect((await scrubPhones(["+17045550001"], { nowMs: () => NOW }))["+17045550001"]!.dnc).toBe(true);
  });

  it("blocks when is_clean is false even with no individual flag set", async () => {
    stubFetch({
      "/v2/api/dnc/scrub/": { queue_id: "s1" },
      "/v2/api/dnc/queue/s1": { status: "complete", download_url: "https://dl/s.csv" },
      "dl/s.csv": "phone,national_dnc,state_dnc,litigator,is_clean\n+17045550001,false,false,false,false\n",
    });
    expect((await scrubPhones(["+17045550001"], { nowMs: () => NOW }))["+17045550001"]!.dnc).toBe(true);
  });

  it("pulls download_url, never clean_download_url", async () => {
    // clean_download_url omits flagged numbers, and those must stay on the card.
    stubFetch({
      "/v2/api/dnc/scrub/": { queue_id: "s1" },
      "/v2/api/dnc/queue/s1": {
        status: "complete",
        download_url: "https://dl/all.csv",
        clean_download_url: "https://dl/clean.csv",
      },
      "dl/all.csv": "phone,national_dnc,state_dnc,litigator,is_clean\n+17045550001,true,false,false,false\n",
    });
    await scrubPhones(["+17045550001"], { nowMs: () => NOW });
    expect(calls.some(c => c.url.includes("clean.csv"))).toBe(false);
    expect(calls.some(c => c.url.includes("all.csv"))).toBe(true);
  });

  it("makes no network call for an empty list", async () => {
    stubFetch({});
    expect(await scrubPhones([], { nowMs: () => NOW })).toEqual({});
    expect(calls).toHaveLength(0);
  });
});

describe("applyScrub", () => {
  const traced: LeadPhone[] = [
    { number: "+17045550001", dnc: true, dncSource: "unscreened", scrubbedAtMs: null },
    { number: "+17045550002", dnc: true, dncSource: "unscreened", scrubbedAtMs: null },
  ];

  it("clears a phone the scrub cleared and stamps when", () => {
    const out = applyScrub(traced, { "+17045550001": { dnc: false }, "+17045550002": { dnc: true } }, NOW);
    expect(out[0]!.dnc).toBe(false);
    expect(out[0]!.scrubbedAtMs).toBe(NOW);
    expect(out[0]!.dncSource).toBe("tracerfy_dnc_v2");
    expect(out[1]!.dnc).toBe(true);
  });

  it("leaves an unanswered phone blocked, with a source that says so", () => {
    const out = applyScrub(traced, {}, NOW);
    expect(out.every(p => p.dnc)).toBe(true);
    expect(out[0]!.dncSource).toBe("scrub_failed");
    expect(out[0]!.scrubbedAtMs).toBeNull();   // so the re-scrub sweep retries it
  });
});
