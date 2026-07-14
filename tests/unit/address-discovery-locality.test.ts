import { describe, expect, it } from "vitest";
import { localityLabelFromAddress } from "../../server/addressDiscovery/boundary";

describe("address discovery locality fallback", () => {
  it("uses detailed locality names before county", () => {
    expect(
      localityLabelFromAddress({
        city: "Lexington",
        county: "Davidson County",
      }),
    ).toBe("Lexington");
    expect(
      localityLabelFromAddress({ hamlet: "Reeds", county: "Davidson County" }),
    ).toBe("Reeds");
  });

  it("allows rural US geometry to proceed with its county label", () => {
    expect(
      localityLabelFromAddress({
        county: "Davidson County",
        state: "North Carolina",
      }),
    ).toBe("Davidson County");
  });
});
