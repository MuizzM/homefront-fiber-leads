// The response sanitizer runs scrubSecretText on every string of every
// non-exempt API response on the single Node thread, so it added an early-exit
// fast path. These tests pin that the fast path is NEVER weaker than the full
// six-regex pass: every secret shape the patterns catch must still be redacted,
// and only genuinely secret-free text may take the cheap path unchanged.
import { describe, expect, it } from "vitest";
import { scrubSecretText, SECRET_TEXT_PATTERNS } from "../../server/secretScrub";

describe("scrubSecretText - redaction is preserved by the fast path", () => {
  // One representative value per pattern in SECRET_TEXT_PATTERNS, in order.
  const secrets: Array<[string, string]> = [
    ["gokinetic url", "call https://api.gokinetic.com/v2/submit?k=1 now"],
    ["gokinetic host", "host is gokinetic.com today"],
    ["basic auth", "Authorization: Basic QWxhZGRpbjpvcGVuc2VzYW1lMTIzNDU2Nzg5MA=="],
    ["bearer jwt", "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghijklmnopqrstuvwxyz"],
    ["raw jwt", "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.sig"],
    ["mapbox token", "pk.eyJ1IjoiaG9tZWZyb250Iiwic29tZXRoaW5nIjoibG9uZ2Vub3VnaCJ9x"],
  ];

  it("still redacts every secret shape (fast path must not skip these)", () => {
    for (const [label, value] of secrets) {
      const out = scrubSecretText(value);
      expect(out, label).toContain("[redacted]");
      expect(out, label).not.toBe(value);
    }
  });

  it("matches the full six-regex pass exactly for secret-bearing strings", () => {
    // Reference implementation without the fast path — the guard must produce
    // identical output, proving it is an optimization, not a behavior change.
    const full = (value: string) => {
      let out = value;
      for (const re of SECRET_TEXT_PATTERNS) { re.lastIndex = 0; out = out.replace(re, "[redacted]"); }
      return out;
    };
    for (const [label, value] of secrets) {
      expect(scrubSecretText(value), label).toBe(full(value));
    }
  });

  it("leaves ordinary field text untouched (the common fast-path case)", () => {
    for (const clean of [
      "1428 Maple Ave, Charlotte NC 28205",
      "Spoke with homeowner - callback Tuesday 4pm",
      "Jose Q. Rodriguez",
      "sold",
      "Basically we agreed", // 'Basic' without the trailing space must NOT trip it
      "they said pkg deal", // 'pk' without '.eyJ' must NOT trip it
      JSON.stringify({ id: 42, status: "not_home", notes: "no answer x3" }),
    ]) {
      expect(scrubSecretText(clean), clean).toBe(clean);
    }
  });

  it("handles empty / non-secret edge values without throwing", () => {
    expect(scrubSecretText("")).toBe("");
    expect(scrubSecretText(null)).toBeNull();
    expect(scrubSecretText(undefined)).toBeUndefined();
  });
});
