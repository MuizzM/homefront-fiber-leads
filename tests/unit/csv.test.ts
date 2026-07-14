import { describe, expect, it } from "vitest";
import { toCsv } from "../../server/csv";

describe("formula-safe CSV", () => {
  it("quotes delimiters and neutralizes spreadsheet formulas", () => {
    const csv = toCsv([
      { address: "100 Main St, Apt 2", note: "=CMD()" },
      { address: "200 Main St", note: "  +SUM(1,2)" },
      { address: "300 Main St", note: "@IMPORTXML(x)" },
    ]);
    expect(csv).toContain('"100 Main St, Apt 2"');
    expect(csv).toContain("'=CMD()");
    expect(csv).toContain('"\'  +SUM(1,2)"');
    expect(csv).toContain("'@IMPORTXML(x)");
  });
});
