// Four findings from the 2026-08-13 tri-audit, pinned.
//
// Each was a control that existed and did not do what it said:
//   1. a rate-limit budget matched by exact lowercase string, on an Express
//      that routes case-insensitively
//   2. an /uploads blocklist tested against a raw path, in front of a handler
//      that resolved a normalised one
//   3. a push endpoint "validated" by its scheme, then POSTed to from the
//      production container
//   4. a bulk lead-create that accepted a rep id its sibling endpoint refused
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  isDedicatedAuthPath,
  isScanMutationPath,
  isScanWorkflowPath,
  isChatPath,
  isScanPollPath,
  normalizeRateLimitPath,
} from "../../server/rateLimitPolicy";
import { isAllowedPushEndpoint } from "../../server/webPush";

const ROOT = path.resolve(__dirname, "../..");

describe("rate-limit matchers survive the spellings Express accepts", () => {
  // Express defaults to caseSensitive:false and strict:false, so all of these
  // reach the SAME handler. Any of them missing the matcher is a free bypass of
  // the budget - including the 120/hour ceiling on money-spending scan calls.
  it.each([
    "/api/scan/start",
    "/API/SCAN/START",
    "/api/scan/Start",
    "/api/scan/start/",
    "/API/Scan/Start/",
  ])("isScanMutationPath(%s)", (p) => {
    expect(isScanMutationPath(p)).toBe(true);
  });

  it("still meters the run-lifecycle actions in every casing", () => {
    expect(isScanMutationPath("/api/scan/runs/ABC123/pause")).toBe(true);
    expect(isScanMutationPath("/API/SCAN/RUNS/ABC123/CANCEL")).toBe(true);
  });

  it("covers the auth endpoints, which carry the brute-force controls", () => {
    // The same defect sat on the tighter per-IP/per-email auth buckets.
    expect(isDedicatedAuthPath("/api/auth/login")).toBe(true);
    expect(isDedicatedAuthPath("/API/AUTH/LOGIN")).toBe(true);
    expect(isDedicatedAuthPath("/api/auth/otp/verify/")).toBe(true);
  });

  it("covers the workflow, chat and poll matchers too", () => {
    expect(isScanWorkflowPath("/API/SWEEPS/city")).toBe(true);
    expect(isChatPath("/API/CHAT/rooms")).toBe(true);
    expect(isScanPollPath("/API/SCANNER/STATE")).toBe(true);
  });

  it("does not over-normalise", () => {
    expect(normalizeRateLimitPath("/")).toBe("/");           // never becomes ""
    expect(normalizeRateLimitPath("")).toBe("");
    expect(isScanMutationPath("/api/scanner/state")).toBe(false); // a poll, not a mutation
    expect(isDedicatedAuthPath("/api/auth/status")).toBe(false);  // not an auth-control path
  });
});

describe("the /uploads blocklist is tested against the path that gets served", () => {
  const src = readFileSync(path.join(ROOT, "server/routes.ts"), "utf8");
  const block = src.slice(src.indexOf("const BLOCKED_UPLOAD_PREFIXES"), src.indexOf("// ── Lead photos"));

  it("normalises before matching", () => {
    // The handler resolves with path.resolve(), which collapses dot segments;
    // the guard used to test the raw req.path, which does not. So
    // /uploads/./licenses/<uuid>.jpg missed every startsWith and was then
    // served from the very directory the guard names.
    expect(block).toContain("path.posix.normalize(req.path)");
    expect(block).not.toMatch(/req\.path\.startsWith\("\/lead-photos\/"\)/);
  });

  it("resolves the SAME normalised string it checked", () => {
    // A guard that normalises one value and serves another is the original bug
    // wearing a hat.
    expect(block).toContain("safeUploadPath");
  });

  it("walls every PII directory that exists under uploads/", () => {
    for (const dir of ["/lead-photos/", "/headshots/", "/licenses/", "/badges/"]) {
      expect(block).toContain(`"${dir}"`);
    }
    // badges/ was created later than the guard and never added; each of these
    // has its own tenant-walled endpoint, so this static route must serve none.
    expect(src).toContain('const badgesDir = path.join(uploadsDir, "badges")');
  });
});

describe("push endpoints are validated by host, not by scheme", () => {
  it("accepts the services that actually mint web-push endpoints", () => {
    for (const url of [
      "https://fcm.googleapis.com/fcm/send/abc123",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAA",
      "https://web.push.apple.com/QABC123",
      "https://par02p.notify.windows.com/w/?token=xyz",
    ]) {
      expect(isAllowedPushEndpoint(url), url).toBe(true);
    }
  });

  it("refuses everything else, which is the whole point", () => {
    for (const url of [
      "https://attacker.example.com/collect",   // the SSRF target
      "https://app:5000/api/health",            // the compose-internal neighbour
      "https://169.254.169.254/latest/meta-data/", // cloud metadata
      "http://fcm.googleapis.com/fcm/send/abc", // downgrade
      "https://fcm.googleapis.com.evil.test/x", // suffix confusion
      "not a url",
      "",
    ]) {
      expect(isAllowedPushEndpoint(url), url).toBe(false);
    }
  });

  it("rejects non-strings rather than throwing", () => {
    for (const v of [null, undefined, 42, {}, []]) {
      expect(isAllowedPushEndpoint(v as unknown)).toBe(false);
    }
  });

  it("the send path does not follow redirects and has a deadline", () => {
    // The allowlist only ever covered the FIRST hop: undici follows redirects
    // by default and imposes no scheme or host gate on them.
    const src = readFileSync(path.join(ROOT, "server/webPush.ts"), "utf8");
    const send = src.slice(src.indexOf("export async function sendPush"));
    expect(send).toContain('redirect: "manual"');
    expect(send).toContain("AbortSignal.timeout(PUSH_REQUEST_TIMEOUT_MS)");
    // Re-checked at send, because rows already in the table predate the allowlist.
    expect(send).toContain("if (!isAllowedPushEndpoint(sub.endpoint))");
  });

  it("the subscribe route uses the allowlist, not the old scheme regex", () => {
    const src = readFileSync(path.join(ROOT, "server/routes.ts"), "utf8");
    const route = src.slice(src.indexOf('app.post("/api/push/subscribe"'));
    const body = route.slice(0, route.indexOf("app.post(\"/api/push/unsubscribe\""));
    expect(body).toContain("isAllowedPushEndpoint(endpoint)");
    expect(body).not.toContain("/^https:\\/\\//.test(endpoint)");
  });
});

describe("lasso-create applies the same rep guards as assign-selection", () => {
  const src = readFileSync(path.join(ROOT, "server/addressPointRoutes.ts"), "utf8");
  const route = src.slice(src.indexOf('app.post("/api/leads/create-from-selection"'));

  it("scope-checks and tenant-checks the client-supplied repId", () => {
    // A team_lead could bulk-assign up to the selection cap to a rep outside
    // their team, or in another tenant, by putting the id in the body - while
    // POST /api/leads/assign-selection refused the very same id.
    expect(route).toContain("repInVisibilityScope(user, repId)");
    expect(route).toContain("repInCallerTenant(user, repId)");
    expect(route).toContain("OUT_OF_SCOPE");
  });

  it("checks BEFORE doing any work, so a refused request creates nothing", () => {
    const guardAt = route.indexOf("repInVisibilityScope(user, repId)");
    const workAt = route.indexOf("addressPointsInRing(ring");
    expect(guardAt).toBeGreaterThan(-1);
    expect(workAt).toBeGreaterThan(guardAt);
  });

  it("takes the guards by injection so there is one implementation", () => {
    expect(src).toContain("repInVisibilityScope: (user: any, repId: number | null | undefined) => boolean");
    const routes = readFileSync(path.join(ROOT, "server/routes.ts"), "utf8");
    const reg = routes.slice(routes.indexOf("registerAddressPointRoutes(app, {"));
    expect(reg.slice(0, 400)).toContain("repInVisibilityScope, repInCallerTenant");
  });
});
