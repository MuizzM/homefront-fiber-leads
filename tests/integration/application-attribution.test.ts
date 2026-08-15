// POST /api/onboarding/apply carries ad attribution from the careers site.
//
// The marketing repo appends channel/utm_*/click-id/_fbp/_fbc fields to the
// application it posts here; this endpoint destructures NAMED fields only, so
// before the attribution columns existed those fields were silently dropped
// and every ad-driven applicant arrived as "direct". These tests pin the
// contract from the outside: what the careers site sends is what the row
// stores, junk keys stay out, and untagged applications stay null.
//
// The multipart body is built by hand: jsdom's FormData plus undici's fetch
// produce a content-length mismatch that hangs multer (see
// tests/integration/onboarding-document-store.test.ts history).

import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let rawDb: import("better-sqlite3").Database;

const BOUNDARY = "----hfsAttributionTestBoundary";

function multipartBody(fields: Record<string, string>): string {
  const parts = Object.entries(fields).map(
    ([name, value]) =>
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
  return parts.join("") + `--${BOUNDARY}--\r\n`;
}

function baseFields(email: string): Record<string, string> {
  return {
    fullName: "Attribution Test Applicant",
    email,
    phone: "(336) 555-0142",
    city: "Greensboro",
    state: "NC",
    zip: "27401",
    hasSalesExperience: "false",
    preferredCarriers: "Kinetic Fiber",
    referralSource: "facebook",
    applicationSource: "careers",
    desiredRole: "Fiber Sales Representative",
    consent: "true",
  };
}

async function postApplication(fields: Record<string, string>) {
  return fetch(`${baseUrl}/api/onboarding/apply`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${BOUNDARY}` },
    body: multipartBody(fields),
  });
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-attribution-api-"));
  process.env.NODE_ENV = "test";
  process.env.APP_ORIGIN = "https://portal.example.com";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  ({ rawDb } = await import("../../server/db"));
  const { registerRoutes } = await import("../../server/routes");

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server?.close();
});

describe("POST /api/onboarding/apply attribution capture", () => {
  it("stores the compact shape the careers site sends: channel plus one JSON field", async () => {
    // This mirrors appendAttributionCompact in the marketing repo exactly.
    // The compact shape exists because the flat one overflowed this
    // endpoint's multipart field cap and the parser 500'd the application.
    const res = await postApplication({
      ...baseFields("tagged-applicant@example.com"),
      channel: "facebook / cpc / triad-reps-aug / video-a",
      attribution: JSON.stringify({
        channel: "facebook / cpc / triad-reps-aug / video-a",
        landing_path: "/careers/",
        utm_source: "facebook",
        utm_medium: "cpc",
        utm_campaign: "triad-reps-aug",
        utm_content: "video-a",
        fbclid: "TESTFBCLID12345",
        fbp: "fb.1.1755100000000.1234567890",
        fbc: "fb.1.1755100000000.TESTFBCLID12345",
        // A key the allowlist does not know. It must never reach the row:
        // this is a public endpoint and the column would otherwise
        // accumulate junk.
        evil_key: "should-not-be-stored",
      }),
    });
    expect(res.status).toBe(201);

    const row = rawDb
      .prepare("SELECT channel, attribution FROM rep_applications WHERE email = ?")
      .get("tagged-applicant@example.com") as { channel: string | null; attribution: string | null };
    expect(row.channel).toBe("facebook / cpc / triad-reps-aug / video-a");
    expect(row.attribution).toBeTruthy();
    const parsed = JSON.parse(row.attribution as string);
    expect(parsed.utm_campaign).toBe("triad-reps-aug");
    expect(parsed.fbclid).toBe("TESTFBCLID12345");
    expect(parsed.fbp).toBe("fb.1.1755100000000.1234567890");
    expect(parsed.landing_path).toBe("/careers/");
    expect(parsed.evil_key).toBeUndefined();
    expect(row.attribution as string).not.toContain("should-not-be-stored");
  });

  it("still accepts the flat shape without tripping the field-count cap", async () => {
    // 13 named fields plus 10 flat attribution fields: 23 total, which the
    // old `fields: 20` multer cap rejected as a 500. The cap is 40 now, and
    // this test is the regression guard that keeps it above the flat shape.
    const res = await postApplication({
      ...baseFields("flat-applicant@example.com"),
      channel: "facebook / cpc / flat-shape",
      landing_path: "/careers/",
      utm_source: "facebook",
      utm_medium: "cpc",
      utm_campaign: "flat-shape",
      utm_content: "image-b",
      utm_term: "fiber",
      fbclid: "FLATCLID99",
      fbp: "fb.1.1755100000001.987654",
      fbc: "fb.1.1755100000001.FLATCLID99",
    });
    expect(res.status).toBe(201);

    const row = rawDb
      .prepare("SELECT channel, attribution FROM rep_applications WHERE email = ?")
      .get("flat-applicant@example.com") as { channel: string | null; attribution: string | null };
    expect(row.channel).toBe("facebook / cpc / flat-shape");
    const parsed = JSON.parse(row.attribution as string);
    expect(parsed.fbclid).toBe("FLATCLID99");
    expect(parsed.utm_term).toBe("fiber");
  });

  it("leaves both columns null when the application arrives untagged", async () => {
    const res = await postApplication(baseFields("untagged-applicant@example.com"));
    expect(res.status).toBe(201);

    const row = rawDb
      .prepare("SELECT channel, attribution FROM rep_applications WHERE email = ?")
      .get("untagged-applicant@example.com") as { channel: string | null; attribution: string | null };
    expect(row.channel).toBeNull();
    expect(row.attribution).toBeNull();
  });

  it("caps oversized attribution values instead of storing them whole", async () => {
    const res = await postApplication({
      ...baseFields("oversized-applicant@example.com"),
      channel: "x".repeat(500),
      utm_campaign: "y".repeat(500),
    });
    expect(res.status).toBe(201);

    const row = rawDb
      .prepare("SELECT channel, attribution FROM rep_applications WHERE email = ?")
      .get("oversized-applicant@example.com") as { channel: string | null; attribution: string | null };
    expect((row.channel as string).length).toBeLessThanOrEqual(200);
    const parsed = JSON.parse(row.attribution as string);
    expect(parsed.utm_campaign.length).toBeLessThanOrEqual(200);
  });
});
