// The shared page grammar (Revolut stat surfaces, Linear list rows — Mobbin).
// These primitives exist so screens adopt a component instead of re-deriving
// eleven Tailwind classes; the tests pin the parts that carry meaning.
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Zap } from "lucide-react";
import {
  ListGroup, ListRow, PageHeader, SectionLabel, StatDelta, StatStrip, StatTile,
} from "../../client/src/components/ui/page-scaffold";

describe("StatTile — the Revolut grammar", () => {
  it("puts the label ABOVE the number, reading order intact", () => {
    render(<StatTile label="Total Sales" value={41} icon={Zap} testId="t" />);
    const tile = screen.getByTestId("t");
    const text = tile.textContent!;
    expect(text.indexOf("Total Sales")).toBeLessThan(text.indexOf("41"));
  });

  it("keeps numbers tabular so columns of stats align digit-for-digit", () => {
    render(<StatTile label="Pay" value="$1,575" testId="t" />);
    expect(screen.getByTestId("t").querySelector(".tabular-nums")).not.toBeNull();
  });

  it("renders a delta as a tinted chip, never a bare colored number", () => {
    render(<StatTile label="Sales" value={7} testId="t" delta={<StatDelta tone="up">+2</StatDelta>} />);
    const chip = screen.getByText("+2");
    expect(chip.className).toContain("rounded-full");
    expect(chip.className).toContain("emerald");
  });
});

describe("StatStrip — one container, hairline cells", () => {
  it("is a single rounded bordered strip, not floating boxes", () => {
    const { container } = render(
      <StatStrip columns={2}><StatTile label="A" value={1} /><StatTile label="B" value={2} /></StatStrip>,
    );
    const strip = container.firstElementChild!;
    expect(strip.className).toContain("gap-px");
    expect(strip.className).toContain("rounded-2xl");
  });
});

describe("ListRow — the Linear grammar", () => {
  it("renders title + one-line description + trailing control", () => {
    render(
      <ListGroup label="Power tools">
        <ListRow title="Commission" description="Flat per sale, or weekly tiers" trailing={<span>chevron</span>} testId="row" />
      </ListGroup>,
    );
    expect(screen.getByTestId("row")).toHaveTextContent("Commission");
    expect(screen.getByTestId("row")).toHaveTextContent("Flat per sale, or weekly tiers");
    expect(screen.getByText("Power tools").className).toContain("uppercase");
  });

  it("is a real button when clickable and a plain div when not", () => {
    const onClick = vi.fn();
    const { rerender } = render(<ListRow title="A" onClick={onClick} testId="row" />);
    expect(screen.getByTestId("row").tagName).toBe("BUTTON");
    fireEvent.click(screen.getByTestId("row"));
    expect(onClick).toHaveBeenCalledOnce();
    rerender(<ListRow title="A" testId="row" />);
    expect(screen.getByTestId("row").tagName).toBe("DIV");
  });
});

describe("PageHeader", () => {
  it("renders exactly one h1", () => {
    render(<PageHeader title="Leaderboard" subtitle="Ranked by sales" />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText("Ranked by sales")).toBeInTheDocument();
  });
});

describe("SectionLabel", () => {
  it("is quiet: small, uppercase, muted", () => {
    render(<SectionLabel>Budget</SectionLabel>);
    const el = screen.getByText("Budget");
    expect(el.className).toContain("uppercase");
    expect(el.className).toContain("text-muted-foreground");
  });
});
