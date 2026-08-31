// ── The 300-rep contract ─────────────────────────────────────────────────────
// The app was built on 6-rep fixtures; a real org runs 300. These tests render
// the pickers at that scale and pin the machinery that makes them usable:
// search appears, at most 60 rows render (with an honest count of the rest),
// typing narrows, recents float, and a small team still sees none of it.
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepPicker } from "../../client/src/components/territory/RepPicker";
import { LassoRepPicker } from "../../client/src/components/map/LassoRepPicker";
import { RepDialogSelect } from "../../client/src/components/people/RepDialogSelect";
import { ROSTER_MAX_ROWS } from "../../client/src/lib/rosterSearch";

const FIRST = ["Ada", "Bo", "Cam", "Dee", "Eli", "Fay", "Gus", "Hal", "Ivy", "Jo"];
const LAST = ["Stone", "Rivera", "Kendal", "Moss", "Park", "Quinn", "Reyes", "Sato", "Tran", "Ueda"];
function bigRoster(n = 300) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: `${FIRST[i % 10]} ${LAST[Math.floor(i / 10) % 10]} ${i + 1}`,
  }));
}

beforeEach(() => {
  try { localStorage.clear(); } catch {}
});
afterEach(cleanup);

describe("RepPicker at 300 reps", () => {
  it("renders at most the row cap and says how many are hidden", () => {
    render(<RepPicker reps={bigRoster()} onChange={vi.fn()} />);
    expect(screen.getAllByRole("option")).toHaveLength(ROSTER_MAX_ROWS);
    expect(screen.getByText(new RegExp(`${300 - ROSTER_MAX_ROWS} more reps`))).toBeInTheDocument();
  });

  it("typing narrows 300 to a handful and the note disappears", async () => {
    const onChange = vi.fn();
    render(<RepPicker reps={bigRoster()} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("Search reps"), "kendal 25");
    // The substring fallback keeps 125 and 225 too - deliberate leniency for
    // a name box; three rows beat three hundred.
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.queryByText(/more reps/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("rep-option-25"));
    expect(onChange).toHaveBeenCalledWith(25);
  });

  it("recently picked reps float to the top under a Recent label", async () => {
    const { unmount } = render(<RepPicker reps={bigRoster()} onChange={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Search reps"), "kendal 25");
    await userEvent.click(screen.getByTestId("rep-option-25"));
    unmount();

    render(<RepPicker reps={bigRoster()} onChange={vi.fn()} />);
    expect(screen.getByTestId("rep-picker-recent-label")).toBeInTheDocument();
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("Eli Kendal 25");
  });

  it("search results never reorder by recents - the row under the cursor stays put", async () => {
    const { unmount } = render(<RepPicker reps={bigRoster()} onChange={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Search reps"), "kendal 25");
    await userEvent.click(screen.getByTestId("rep-option-25"));
    unmount();

    render(<RepPicker reps={bigRoster()} onChange={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Search reps"), "kendal");
    // Lexicographic within the hits ("121" < "21") - id 25 must NOT jump the
    // queue mid-search, and the Recent label must be gone.
    expect(screen.queryByTestId("rep-picker-recent-label")).not.toBeInTheDocument();
    const first = screen.getAllByRole("option")[0];
    expect(first).toHaveTextContent("Ada Kendal 121");
  });

  it("ArrowDown from the search box moves focus into the list", async () => {
    render(<RepPicker reps={bigRoster()} onChange={vi.fn()} />);
    const input = screen.getByLabelText("Search reps");
    input.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getAllByRole("option")[0]);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getAllByRole("option")[1]);
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(document.activeElement).toBe(input);
  });

  it("a six-rep team sees no search box, no cap note, no recent label", () => {
    render(<RepPicker reps={bigRoster(6)} onChange={vi.fn()} />);
    expect(screen.queryByLabelText("Search reps")).not.toBeInTheDocument();
    expect(screen.queryByText(/more reps/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(6);
  });
});

describe("LassoRepPicker at 300 reps", () => {
  const reps = bigRoster().map((r) => ({ ...r, doors: 3 }));

  it("gets a search box, the row cap, and the honest hidden count", () => {
    render(<LassoRepPicker reps={reps} value="" onChange={vi.fn()} selectionCount={10} />);
    expect(screen.getByTestId("lasso-rep-search")).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(ROSTER_MAX_ROWS);
    expect(screen.getByTestId("lasso-rep-hidden")).toHaveTextContent(`${300 - ROSTER_MAX_ROWS} more reps`);
  });

  it("typing finds the rep; picking still reports through onChange", async () => {
    const onChange = vi.fn();
    render(<LassoRepPicker reps={reps} value="" onChange={onChange} selectionCount={10} />);
    await userEvent.type(screen.getByTestId("lasso-rep-search"), "kendal 25");
    await userEvent.click(screen.getByTestId("lasso-rep-25"));
    expect(onChange).toHaveBeenCalledWith("25");
  });

  it("says so when nothing matches instead of an empty pane", async () => {
    render(<LassoRepPicker reps={reps} value="" onChange={vi.fn()} selectionCount={10} />);
    await userEvent.type(screen.getByTestId("lasso-rep-search"), "zzz");
    expect(screen.getByRole("status")).toHaveTextContent(/No rep matches/);
  });

  it("a small crew still sees the plain picker - no search box", () => {
    render(<LassoRepPicker reps={reps.slice(0, 6)} value="" onChange={vi.fn()} selectionCount={10} />);
    expect(screen.queryByTestId("lasso-rep-search")).not.toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(6);
  });
});

describe("RepDialogSelect", () => {
  it("opens the searchable picker, picks, closes, and keeps the site's testid", async () => {
    const onPick = vi.fn();
    render(
      <RepDialogSelect
        testId="panel-reassign-select"
        triggerLabel="Reassign to rep…"
        reps={bigRoster()}
        onPick={onPick}
      />,
    );
    await userEvent.click(screen.getByTestId("panel-reassign-select"));
    await userEvent.type(await screen.findByLabelText("Search reps"), "kendal 25");
    await userEvent.click(screen.getByTestId("rep-option-25"));
    expect(onPick).toHaveBeenCalledWith(25);
    expect(screen.queryByLabelText("Search reps")).not.toBeInTheDocument();
  });

  it("extra rows and the none row sit above the list and fire their own picks", async () => {
    const onPick = vi.fn(); const onNone = vi.fn(); const onAll = vi.fn();
    render(
      <RepDialogSelect
        testId="filter-rep"
        triggerLabel="All reps"
        reps={bigRoster()}
        onPick={onPick}
        noneLabel="Unassigned"
        onNone={onNone}
        extraRows={[{ key: "all", label: "All reps", onPick: onAll }]}
      />,
    );
    await userEvent.click(screen.getByTestId("filter-rep"));
    await userEvent.click(await screen.findByTestId("rep-dialog-extra-all"));
    expect(onAll).toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("filter-rep"));
    await userEvent.click(await screen.findByTestId("rep-dialog-none"));
    expect(onNone).toHaveBeenCalled();
  });
});
