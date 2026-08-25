import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THE INCUMBENT BELONGS ON THE DOOR CARD.
 *
 * LeadCard already renders a competitor badge and a "Competitor" fact chip. The
 * projector already SELECTED latest.competitor_name. It just never wrote it, so
 * every lead minted from a scan reached the rep with an empty competitor - and
 * measured live during a Concord run: 1,466 scanned doors held a competitor,
 * 13 leads were created from them, and 0 carried one.
 *
 * Which incumbent it is changes the pitch. Google Fiber is not Spectrum.
 */
let rawDb: import("better-sqlite3").Database;
let persist: typeof import("../../server/kineticObservation").persistKineticObservation;
const TENANT = 1;

const body = (competitor: string | null, tech = "Cable", speed = "1000") => ({
  maxQual: "QUAL UP TO 1 GIG RANGE VIA FIBER",
  techType: "FIBER",
  validationResult: "AddressFound",
  broadbandService: { technologyType: "FIBER" },
  address: {
    billingStatus: "N", householdSegmentType: "NEW FIBER",
    ...(competitor ? { competitorCompanyName: competitor, competitorTechName: tech, competitorQualSpeed: speed } : {}),
  },
});

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-comp-"));
  ({ rawDb } = await import("../../server/db"));
  (await import("../../server/storage")).runMigrations();
  ({ persistKineticObservation: persist } = await import("../../server/kineticObservation"));
});
beforeEach(() => {
  rawDb.prepare("DELETE FROM leads").run();
  rawDb.prepare("DELETE FROM scan_targets").run();
  rawDb.prepare("DELETE FROM availability_snapshots").run();
});

let n = 0;
function scan(raw: any) {
  const addr = `${100 + (++n)} Corban Ave SE`;
  persist({
    tenantId: TENANT, source: "test",
    observation: {
      address: addr, city: "Concord", state: "NC", zip: "28025",
      lat: 35.40 + n * 0.0001, lng: -80.58,
      fiberStatus: "new_fiber", fiberAvailable: true, isNewFiber: true,
      billingStatus: "N", householdSegmentType: "NEW FIBER", rawResponse: raw,
    } as any,
  } as any);
  return addr;
}
const targetFor = (a: string) => rawDb.prepare("SELECT * FROM scan_targets WHERE address=?").get(a) as any;
const leadFor = (a: string) => rawDb.prepare("SELECT * FROM leads WHERE address=?").get(a) as any;

describe("the competitor reaches the door card", () => {
  it("stores the incumbent on the scanned door", () => {
    const a = scan(body("Google Fiber"));
    expect(targetFor(a).competitor_company).toBe("Google Fiber");
  });

  it("stores its technology and speed for the card's chips", () => {
    const a = scan(body("Google Fiber", "Fiber", "2000"));
    const t = targetFor(a);
    expect(t.competitor_tech).toBe("Fiber");
    expect(t.competitor_speed_mbps).toBe(2000);
  });

  it("puts the competitor on the LEAD, which is what the card reads", () => {
    const a = scan(body("Google Fiber"));
    const l = leadFor(a);
    expect(l).toBeTruthy();
    expect(l.competitor_name).toBe("Google Fiber");
  });

  it("distinguishes Google Fiber from Spectrum rather than flattening both", () => {
    const g = scan(body("Google Fiber"));
    const s = scan(body("Spectrum"));
    expect(leadFor(g).competitor_name).toBe("Google Fiber");
    expect(leadFor(s).competitor_name).toBe("Spectrum");
  });

  it("leaves it null when the provider names no competitor", () => {
    const a = scan(body(null));
    expect(targetFor(a).competitor_company).toBeNull();
    const l = leadFor(a);
    if (l) expect(l.competitor_name).toBeNull();
  });

  it("ignores a zero speed rather than storing a fake 0 Mbps", () => {
    const a = scan(body("Spectrum", "Cable", "0"));
    expect(targetFor(a).competitor_speed_mbps).toBeNull();
  });

  it("does not overwrite a competitor already known on an existing lead", () => {
    const a = scan(body("Google Fiber"));
    expect(leadFor(a).competitor_name).toBe("Google Fiber");
    scan(body("Spectrum"));                       // a later, different answer
    const still = rawDb.prepare("SELECT competitor_name FROM leads WHERE address=?").get(a) as any;
    expect(still.competitor_name).toBe("Google Fiber");
  });

  it('treats "NO COMPETITOR" as no competitor, not as a company named that', () => {
    const a = scan(body("NO COMPETITOR"));
    expect(targetFor(a).competitor_company).toBeNull();
    const l = leadFor(a);
    if (l) expect(l.competitor_name).toBeNull();
  });

  it("survives a response with no address block", () => {
    expect(() => scan({ maxQual: "QUAL", validationResult: "AddressFound" })).not.toThrow();
  });
});
