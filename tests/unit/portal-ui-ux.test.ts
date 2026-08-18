import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("portal UI and accessibility contracts", () => {
  it("keeps one page-level heading in the scanner workspace", () => {
    expect(read("client/src/pages/Scanners.tsx").match(/<h1\b/g)).toHaveLength(1);
    for (const file of ["CityScanner.tsx", "USAScanner.tsx", "KineticScanner.tsx"]) {
      expect(read(`client/src/pages/${file}`)).not.toMatch(/<h1\b/);
    }
  });

  it("gives the calling queue a page heading without duplicating the lead heading", () => {
    expect(read("client/src/pages/CallingQueue.tsx")).toContain("<CallingChrome pageTitle>");
    expect(read("client/src/pages/CallingLead.tsx")).toContain("<CallingChrome>");
    expect(read("client/src/components/calling/CallingChrome.tsx")).toContain("<h1");
  });

  it("shows an honest map boot state instead of a blank canvas", () => {
    const map = read("client/src/pages/MapView.tsx");
    expect(map).toContain('data-testid="map-boot-status"');
    expect(map).toContain("!mapReady && !noToken");
    expect(map).toContain("Preparing your field map");
  });

  it("does not tell a user to share an unavailable referral link", () => {
    const referrals = read("client/src/pages/Referrals.tsx");
    expect(referrals).not.toContain("Share your link to get started.");
    expect(referrals).toContain("No referral activity yet.");
  });

  it("makes long navigation sections collapsible and accessible", () => {
    const layout = read("client/src/pages/Layout.tsx");
    expect(layout).toContain("aria-expanded={groupOpen}");
    expect(layout).toContain("aria-controls={groupId}");
    expect(layout).toContain("hidden={!groupOpen}");
  });
});
