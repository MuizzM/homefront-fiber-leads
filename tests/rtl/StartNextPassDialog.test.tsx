// The confirm dialog for re-opening an area.
//
// The risk this UI carries is a confident click on wrong numbers, so the tests
// concentrate on the honesty of what's shown: the counts match the preview, the
// callback warning appears when promises are about to be dropped, the toggle
// actually re-previews, and nothing on screen suggests history is being erased.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StartNextPassDialog, type PassPreview } from "../../client/src/components/territory/StartNextPassDialog";
import { PassHistory } from "../../client/src/components/territory/PassHistory";

const basePreview: PassPreview = {
  currentPass: 1, nextPass: 2, territoryName: "Maple Grove",
  totals: { total: 10, reset: 7, frozen: 3 },
  frozenByReason: { sold: 2, do_not_knock: 1 },
  callbacksAtRisk: 0,
};

function setup(over: Partial<PassPreview> = {}, props: Record<string, any> = {}) {
  const fetchPreview = vi.fn().mockResolvedValue({ ...basePreview, ...over });
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();
  render(
    <StartNextPassDialog
      open territoryId={1}
      fetchPreview={fetchPreview}
      onConfirm={onConfirm}
      onCancel={onCancel}
      reps={[{ id: 5, name: "Bo Rivera" }, { id: 6, name: "Cam Diaz" }]}
      {...props}
    />,
  );
  return { fetchPreview, onConfirm, onCancel };
}

describe("StartNextPassDialog", () => {
  it("shows how many doors re-open and how many are left alone", async () => {
    setup();
    expect(await screen.findByText("7")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText(/doors re-open/)).toBeInTheDocument();
  });

  it("explains each reason a door is being left alone", async () => {
    setup();
    expect(await screen.findByText("Sold")).toBeInTheDocument();
    expect(screen.getByText(/nobody knocks a customer/i)).toBeInTheDocument();
    expect(screen.getByText("Do not knock")).toBeInTheDocument();
  });

  it("names the pass being opened, so the button is unambiguous", async () => {
    setup({ currentPass: 2, nextPass: 3 });
    expect(await screen.findByRole("button", { name: "Start pass 3" })).toBeInTheDocument();
  });

  it("says history is kept — never implies a wipe", async () => {
    setup();
    expect(await screen.findByText(/stays in this area's history/i)).toBeInTheDocument();
    expect(screen.queryByText(/delete|erase|permanently remove/i)).not.toBeInTheDocument();
  });

  // ── The promise-dropping warning ────────────────────────────────────────────
  it("warns when scheduled callbacks are about to be cleared", async () => {
    setup({ callbacksAtRisk: 3 });
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/3 doors have callbacks scheduled/i)).toBeInTheDocument();
  });

  it("stays quiet when there are no callbacks at risk — no crying wolf", async () => {
    setup({ callbacksAtRisk: 0 });
    await screen.findByText("7");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("re-previews when callbacks are protected, so the counts stay truthful", async () => {
    const user = userEvent.setup();
    const { fetchPreview } = setup({ callbacksAtRisk: 2 });
    await screen.findByRole("alert");
    expect(fetchPreview).toHaveBeenLastCalledWith(1, false);

    await user.click(screen.getByLabelText(/keep scheduled callbacks/i));
    await waitFor(() => expect(fetchPreview).toHaveBeenLastCalledWith(1, true));
  });

  // ── Territory choice ────────────────────────────────────────────────────────
  it("defaults to keeping the same rep and passes that through", async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await user.click(await screen.findByRole("button", { name: "Start pass 2" }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ territoryAction: "keep" }));
  });

  it("offers the pool and reassign options", async () => {
    setup();
    expect(await screen.findByLabelText(/put the area back in the pool/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/hand it to someone else/i)).toBeInTheDocument();
  });

  it("blocks confirm until a rep is chosen for reassign", async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await user.click(await screen.findByLabelText(/hand it to someone else/i));

    const confirm = screen.getByRole("button", { name: "Start pass 2" });
    expect(confirm).toBeDisabled();

    await user.selectOptions(screen.getByLabelText(/rep to hand the area to/i), "5");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ territoryAction: "reassign", newRepId: 5 }));
  });

  it("sends the note when one is typed", async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await screen.findByText("7");
    await user.type(screen.getByPlaceholderText(/spring sweep/i), "After the build-out");
    await user.click(screen.getByRole("button", { name: "Start pass 2" }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ note: "After the build-out" }));
  });

  // ── States ──────────────────────────────────────────────────────────────────
  it("shows a loading state instead of empty counts", () => {
    render(
      <StartNextPassDialog open territoryId={1}
        fetchPreview={() => new Promise(() => {})}
        onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/working out what this will change/i);
    expect(screen.getByRole("button", { name: /start next pass/i })).toBeDisabled();
  });

  it("surfaces a failed preview rather than offering a blind confirm", async () => {
    render(
      <StartNextPassDialog open territoryId={1}
        fetchPreview={() => Promise.reject(new Error("network down"))}
        onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("network down");
    expect(screen.getByRole("button", { name: /start next pass/i })).toBeDisabled();
  });

  it("renders nothing when closed", () => {
    render(<StartNextPassDialog open={false} territoryId={1}
      fetchPreview={vi.fn()} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("is a labelled modal dialog", async () => {
    setup();
    const dlg = await screen.findByRole("dialog");
    expect(dlg).toHaveAttribute("aria-modal", "true");
    expect(dlg).toHaveAccessibleName(/start pass 2/i);
  });

  // ── Theme + surface (owner screenshot: stark white card over the dark
  //    glass panel) ─────────────────────────────────────────────────────────
  it("renders on the house card surface, never a hardcoded white sheet", async () => {
    setup();
    const card = await screen.findByTestId("next-pass-card");
    expect(card.className).toMatch(/\bbg-card\b/);
    expect(card.className).toMatch(/\bborder-border\b/);
    expect(card.className).toMatch(/\btext-foreground\b/);
    expect(card.className).not.toMatch(/bg-white|bg-background/);
  });

  it("dims the page behind it and a tap on the scrim cancels", async () => {
    const { onCancel } = setup();
    await screen.findByText("7");
    const scrim = screen.getByTestId("next-pass-scrim");
    expect(scrim.className).toMatch(/bg-black\/60/);
    await userEvent.setup().click(scrim);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  // ── Skeletons, then real tiles — never empty ghost boxes ──────────────────
  it("shows skeleton tiles while the preview loads, then the real counts", async () => {
    let resolve!: (p: PassPreview) => void;
    render(
      <StartNextPassDialog open territoryId={1}
        fetchPreview={() => new Promise<PassPreview>(r => { resolve = r; })}
        onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    // While loading: skeleton tiles in the stat slots, no count tiles at all.
    expect(screen.getAllByTestId("pass-preview-skeleton")).toHaveLength(2);
    expect(screen.queryByTestId("pass-reset-tile")).toBeNull();
    expect(screen.queryByTestId("pass-frozen-tile")).toBeNull();

    resolve({ ...basePreview, totals: { total: 10, reset: 0, frozen: 0 }, frozenByReason: {} });
    await waitFor(() => expect(screen.queryAllByTestId("pass-preview-skeleton")).toHaveLength(0));
    // Zero is a real answer: the tiles render 0, tabular, not an empty box.
    expect(screen.getByTestId("pass-reset-count")).toHaveTextContent("0");
    expect(screen.getByTestId("pass-frozen-count")).toHaveTextContent("0");
    expect(screen.getByTestId("pass-reset-count").className).toMatch(/tabular-nums/);
    expect(screen.getByTestId("pass-frozen-count").className).toMatch(/tabular-nums/);
  });

  it("re-shows skeletons (not stale or empty tiles) while the toggle re-previews", async () => {
    const user = userEvent.setup();
    let resolveSecond: ((p: PassPreview) => void) | null = null;
    let calls = 0;
    render(
      <StartNextPassDialog open territoryId={1}
        fetchPreview={() => {
          calls += 1;
          if (calls === 1) return Promise.resolve({ ...basePreview, callbacksAtRisk: 2 });
          return new Promise<PassPreview>(r => { resolveSecond = r; });
        }}
        onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    await screen.findByRole("alert");
    await user.click(screen.getByLabelText(/keep scheduled callbacks/i));
    await waitFor(() => expect(screen.getAllByTestId("pass-preview-skeleton")).toHaveLength(2));
    expect(screen.queryByTestId("pass-reset-tile")).toBeNull();
    resolveSecond!({ ...basePreview, callbacksAtRisk: 0 });
    await waitFor(() => expect(screen.getByTestId("pass-reset-count")).toHaveTextContent("7"));
  });

  // ── Pending + targets ──────────────────────────────────────────────────────
  it("disables both footer buttons while the start is committing", async () => {
    setup({}, { busy: true });
    const confirm = await screen.findByTestId("next-pass-confirm");
    expect(confirm).toBeDisabled();
    expect(screen.getByTestId("next-pass-cancel")).toBeDisabled();
    expect(screen.getByTestId("next-pass-scrim")).toBeDisabled();
  });

  it("footer buttons are 44px targets; radio rows are 44px, fully clickable, and mark selection", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("7");
    expect(screen.getByTestId("next-pass-confirm").className).toMatch(/\bh-11\b/);
    expect(screen.getByTestId("next-pass-cancel").className).toMatch(/\bh-11\b/);

    const keepRow = screen.getByTestId("pass-action-row-keep");
    const poolRow = screen.getByTestId("pass-action-row-return_to_pool");
    expect(keepRow.className).toMatch(/min-h-11/);
    // Default selection is visible, not just a radio dot.
    expect(keepRow.className).toMatch(/border-primary/);
    expect(keepRow.className).toMatch(/bg-primary\/\[0\.07\]/);
    expect(poolRow.className).not.toMatch(/bg-primary\/\[0\.07\]/);

    // The whole row is the control: clicking row text selects the option.
    await user.click(within(poolRow).getByText(/put the area back in the pool/i));
    expect(screen.getByTestId("pass-action-return_to_pool")).toBeChecked();
    expect(screen.getByTestId("pass-action-row-return_to_pool").className).toMatch(/bg-primary\/\[0\.07\]/);
  });
});

describe("PassHistory", () => {
  const row = (over: Partial<any> = {}) => ({
    id: 1, passNumber: 1, closedAt: "2026-03-04T12:00:00.000Z", closedByName: "Mona Manager",
    territoryAction: "keep", leadsTotal: 10, leadsReset: 7, leadsFrozen: 3, note: null,
    stats: { knocks: 24, doorsAnswered: 14, sold: 3, interested: 4, notInterested: 6, notHome: 10, callbacks: 1 },
    ...over,
  });

  it("lists past passes with what each one produced", () => {
    render(<PassHistory currentPass={2} passes={[row()]} />);
    expect(screen.getByText("Pass 1")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();      // sold
    expect(screen.getByText(/closed .* by Mona Manager/)).toBeInTheDocument();
    expect(screen.getByText(/now on pass 2/)).toBeInTheDocument();
  });

  it("orders newest first, as given", () => {
    render(<PassHistory currentPass={4} passes={[row({ id: 3, passNumber: 3 }), row({ id: 2, passNumber: 2 }), row()]} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Pass 3");
    expect(items[2]).toHaveTextContent("Pass 1");
  });

  it("explains the empty state without sounding broken", () => {
    render(<PassHistory currentPass={1} passes={[]} />);
    expect(screen.getByText(/first pass in progress/i)).toBeInTheDocument();
    expect(screen.getByText(/pass 1's results stay here/i)).toBeInTheDocument();
  });

  it("shows the note a manager left", () => {
    render(<PassHistory currentPass={2} passes={[row({ note: "Revisit after build-out" })]} />);
    expect(screen.getByText(/revisit after build-out/i)).toBeInTheDocument();
  });

  it("has loading and error states", () => {
    const { rerender } = render(<PassHistory currentPass={1} passes={[]} loading />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    rerender(<PassHistory currentPass={1} passes={[]} error="could not load" />);
    expect(screen.getByRole("alert")).toHaveTextContent("could not load");
  });
});
