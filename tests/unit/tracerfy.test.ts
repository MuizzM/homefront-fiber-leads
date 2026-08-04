// Skip-trace / DNC decision layer.
//
// The tests that matter here are the ones about FAILING CLOSED. A DNC bug does
// not look like a crash — it looks like a number quietly appearing in a dialer,
// and the first symptom is a demand letter. So most of this file is about the
// boring cases: no data, stale data, partial data.
import { describe, expect, it } from "vitest";
import {
  verdictForPhone, actionsForLead, dialableNumbers, buildLeadCard,
  leadDisplayName, needsRescrub, rankPhones, rankEmails, dncExplanation,
  SCRUB_TTL_DAYS, DMA_BLOCKS_CALLING, DISPLAY_LIMIT,
  type TracedPhone,
} from "../../shared/tracerfy";

const NOW = Date.UTC(2026, 7, 4, 12, 0, 0);
const DAY = 86_400_000;

function phone(over: Partial<TracedPhone> = {}): TracedPhone {
  return {
    number: "+15551230001",
    lineType: "wireless",
    confidence: 0.9,
    dncFlags: {},
    scrubbedAtMs: NOW - DAY,
    ...over,
  };
}

describe("a phone is only callable when we can prove it", () => {
  it("clears a freshly scrubbed number with no flags", () => {
    const v = verdictForPhone(phone(), NOW);
    expect(v.dnc).toBe(false);
    expect(v.reasons).toEqual([]);
  });

  it("blocks on the federal registry", () => {
    const v = verdictForPhone(phone({ dncFlags: { federalDnc: true } }), NOW);
    expect(v.dnc).toBe(true);
    expect(v.reasons).toContain("federal_dnc");
  });

  it("blocks on a state registry even when federal is clear", () => {
    const v = verdictForPhone(phone({ dncFlags: { federalDnc: false, stateDnc: true } }), NOW);
    expect(v.dnc).toBe(true);
    expect(v.reasons).toContain("state_dnc");
  });

  it("blocks a known TCPA litigator", () => {
    const v = verdictForPhone(phone({ dncFlags: { tcpaLitigator: true } }), NOW);
    expect(v.dnc).toBe(true);
    expect(v.reasons).toContain("tcpa_litigator");
  });

  it("treats a NEVER-scrubbed number as not callable", () => {
    // The common case by volume: the trace returned a phone and the scrub
    // hasn't run yet. Absence of a flag is not evidence of absence from the
    // registry.
    const v = verdictForPhone(phone({ scrubbedAtMs: null }), NOW);
    expect(v.dnc).toBe(true);
    expect(v.reasons).toEqual(["never_scrubbed"]);
  });

  it("expires a scrub older than the TTL", () => {
    // Federal safe harbour caps reliance at 31 days. A number added to the
    // registry after our last scrub is protected today regardless.
    const stale = phone({ scrubbedAtMs: NOW - (SCRUB_TTL_DAYS + 1) * DAY });
    expect(verdictForPhone(stale, NOW).reasons).toContain("scrub_expired");
    expect(verdictForPhone(stale, NOW).dnc).toBe(true);
  });

  it("keeps a scrub valid right up to the TTL boundary", () => {
    const edge = phone({ scrubbedAtMs: NOW - SCRUB_TTL_DAYS * DAY });
    expect(verdictForPhone(edge, NOW).dnc).toBe(false);
  });

  it("keeps the TTL under the 31-day statutory ceiling", () => {
    // A job that runs "monthly" drifts; drifting past 31 days is the failure.
    expect(SCRUB_TTL_DAYS).toBeLessThan(31);
  });

  it("surfaces DMA without blocking on it", () => {
    // DMAchoice is a MAIL preference service, not a telephone registry.
    // Blocking calls on it would suppress legitimately callable leads.
    expect(DMA_BLOCKS_CALLING).toBe(false);
    const v = verdictForPhone(phone({ dncFlags: { dma: true } }), NOW);
    expect(v.dnc).toBe(false);
    expect(v.dncFlags.dma).toBe(true);   // recorded and renderable
  });

  it("normalizes missing flags to false rather than undefined", () => {
    const v = verdictForPhone(phone({ dncFlags: {} }), NOW);
    expect(v.dncFlags).toEqual({ federalDnc: false, stateDnc: false, dma: false, tcpaLitigator: false });
  });

  it("reports every reason, not just the first", () => {
    const v = verdictForPhone(phone({
      dncFlags: { federalDnc: true, stateDnc: true, tcpaLitigator: true },
      scrubbedAtMs: null,
    }), NOW);
    expect(v.reasons.sort()).toEqual(["federal_dnc", "never_scrubbed", "state_dnc", "tcpa_litigator"]);
  });
});

describe("what a rep is told", () => {
  it("distinguishes 'on the registry' from 'we haven't checked'", () => {
    // These are different problems: one is permanent and about the person, the
    // other is ours and clears itself. A rep who can't tell them apart learns
    // to ignore the badge.
    expect(dncExplanation(["federal_dnc"])).toMatch(/federal/i);
    expect(dncExplanation(["never_scrubbed"])).toMatch(/not dnc-checked/i);
    expect(dncExplanation(["scrub_expired"])).toMatch(/expired/i);
    expect(dncExplanation([])).toBe("OK to call");
  });

  it("leads with the litigator warning when several reasons apply", () => {
    expect(dncExplanation(["federal_dnc", "tcpa_litigator"])).toMatch(/litigator/i);
  });
});

describe("routing — the part that gets you sued", () => {
  it("never returns a DNC number as dialable", () => {
    const verdicts = [
      verdictForPhone(phone({ number: "+15550000001" }), NOW),
      verdictForPhone(phone({ number: "+15550000002", dncFlags: { federalDnc: true } }), NOW),
      verdictForPhone(phone({ number: "+15550000003", scrubbedAtMs: null }), NOW),
    ];
    expect(dialableNumbers(verdicts).map(v => v.number)).toEqual(["+15550000001"]);
  });

  it("refuses call_allowed when the calling engine says no, even with a clear number", () => {
    // shared/calling.ts is the authority — internal DNC, consent revocation,
    // quiet hours and stale-dataset gating all live there and none of them are
    // visible to this module. A clear provider flag is necessary, not sufficient.
    const clear = [verdictForPhone(phone(), NOW)];
    expect(actionsForLead(clear, false)).toEqual(["door_knock_only"]);
    expect(actionsForLead(clear, true)).toEqual(["door_knock", "call_allowed"]);
  });

  it("still allows knocking when every number is DNC", () => {
    // DNC governs telephone solicitation, not walking up to a door. The whole
    // point of the feature is that the door survives.
    const blocked = [verdictForPhone(phone({ dncFlags: { federalDnc: true } }), NOW)];
    expect(actionsForLead(blocked, true)).toEqual(["door_knock_only"]);
  });

  it("allows knocking on a lead with no phones at all", () => {
    expect(actionsForLead([], true)).toEqual(["door_knock_only"]);
  });
});

describe("the lead card", () => {
  const base = {
    leadId: 42, areaId: 7, name: "Resident at 123 Main St",
    address: "123 Main St, Rockwell, NC 28138",
    dwellingType: "SFH" as const, fiberStatus: "fiber",
    emails: [{ email: "a@x.test", confidence: 0.8 }],
    callingEngineAllows: true, nowMs: NOW,
  };

  it("keeps a DNC number VISIBLE and badges it", () => {
    // Removing it loses the context a knocker needs at the door. The rule is
    // "don't dial", not "don't know".
    const card = buildLeadCard({
      ...base,
      phones: [phone({ number: "+15551110000", dncFlags: { federalDnc: true } })],
    });
    expect(card.phones).toHaveLength(1);
    expect(card.phones[0]!.number).toBe("+15551110000");
    expect(card.phones[0]!.badge).toBe("DNC – do not dial");
    expect(card.actions).toEqual(["door_knock_only"]);
  });

  it("badges a clear number OK to call", () => {
    const card = buildLeadCard({ ...base, phones: [phone()] });
    expect(card.phones[0]!.badge).toBe("OK to call");
    expect(card.actions).toEqual(["door_knock", "call_allowed"]);
  });

  it("caps DISPLAY at 3 but decides actions from ALL phones", () => {
    // The 4th phone is the only callable one. If actions were computed from the
    // truncated display list the lead would read as door-knock-only and a
    // legitimate call would never be made.
    const phones = [
      phone({ number: "+1555000001", confidence: 0.99, dncFlags: { federalDnc: true } }),
      phone({ number: "+1555000002", confidence: 0.98, dncFlags: { federalDnc: true } }),
      phone({ number: "+1555000003", confidence: 0.97, dncFlags: { federalDnc: true } }),
      phone({ number: "+1555000004", confidence: 0.10 }),
    ];
    const card = buildLeadCard({ ...base, phones, displayOnly: true });
    expect(card.phones).toHaveLength(DISPLAY_LIMIT);
    expect(card.truncated.phones).toBe(true);
    expect(card.actions).toEqual(["door_knock", "call_allowed"]);
  });

  it("returns everything when not display-capped", () => {
    const phones = Array.from({ length: 6 }, (_, i) =>
      phone({ number: `+155500000${i}`, confidence: 1 - i / 10 }));
    const card = buildLeadCard({ ...base, phones });
    expect(card.phones).toHaveLength(6);
    expect(card.truncated.phones).toBe(false);
  });

  it("orders phones by confidence, stably", () => {
    const a = phone({ number: "+15550000009", confidence: 0.5 });
    const b = phone({ number: "+15550000001", confidence: 0.5 });
    expect(rankPhones([a, b]).map(p => p.number)).toEqual(rankPhones([b, a]).map(p => p.number));
    expect(rankPhones([b, a])[0]!.number).toBe("+15550000001");   // tie broken by number
  });

  it("orders emails by confidence", () => {
    const out = rankEmails([
      { email: "low@x.test", confidence: 0.1 },
      { email: "high@x.test", confidence: 0.9 },
    ]);
    expect(out[0]!.email).toBe("high@x.test");
  });

  it("carries the full JSON contract", () => {
    const card = buildLeadCard({ ...base, phones: [phone()] });
    expect(Object.keys(card).sort()).toEqual(
      ["actions", "address", "areaId", "dwellingType", "emails", "fiberStatus", "leadId", "name", "phones", "truncated"]);
    expect(Object.keys(card.phones[0]!).sort()).toEqual(
      ["badge", "confidence", "dnc", "dncFlags", "lineType", "number", "reasons"]);
  });
});

describe("lead naming", () => {
  it("uses the owner name when the trace returned one", () => {
    expect(leadDisplayName("Dana Whitfield", "123 Main St, Rockwell NC")).toBe("Dana Whitfield");
  });

  it("falls back to the street, never an invented person", () => {
    // A knocker opening with the wrong name loses the door before the pitch.
    expect(leadDisplayName(null, "123 Main St, Rockwell, NC 28138")).toBe("Resident at 123 Main St");
    expect(leadDisplayName("", "123 Main St")).toBe("Resident at 123 Main St");
    expect(leadDisplayName("   ", "123 Main St")).toBe("Resident at 123 Main St");
  });

  it("rejects junk the provider sometimes returns as a name", () => {
    expect(leadDisplayName("--", "9 Oak Ave")).toBe("Resident at 9 Oak Ave");
    expect(leadDisplayName("1", "9 Oak Ave")).toBe("Resident at 9 Oak Ave");
  });
});

describe("re-scrub scheduling", () => {
  it("picks up never-scrubbed and expired phones, leaves fresh ones", () => {
    const phones = [
      phone({ number: "+1555fresh", scrubbedAtMs: NOW - DAY }),
      phone({ number: "+1555stale", scrubbedAtMs: NOW - (SCRUB_TTL_DAYS + 5) * DAY }),
      phone({ number: "+1555never", scrubbedAtMs: null }),
    ];
    expect(needsRescrub(phones, NOW).map(p => p.number)).toEqual(["+1555stale", "+1555never"]);
  });

  it("is exactly the set that verdictForPhone would block for staleness", () => {
    // These two must never drift apart: anything blocked for staleness has to
    // be queued for re-scrub, or a lead goes permanently uncallable in silence.
    const phones = Array.from({ length: 40 }, (_, i) =>
      phone({ number: `+1555${i}`, scrubbedAtMs: i % 3 === 0 ? null : NOW - i * DAY }));
    const blockedForAge = phones.filter(p => {
      const r = verdictForPhone(p, NOW).reasons;
      return r.includes("never_scrubbed") || r.includes("scrub_expired");
    });
    expect(needsRescrub(phones, NOW)).toEqual(blockedForAge);
  });
});
