// ── Cmd-K command palette ────────────────────────────────────────────────────
//
// The palette is the shell's one keystroke to anywhere. These tests pin the
// contract that makes it safe to trust: it opens on Cmd-K / Ctrl-K and from
// the sidebar field, it lists exactly the pages the sidebar would show this
// role (never a page the role cannot open), Enter or a tap navigates through
// the hash router, and Escape closes it without leaving the page.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, describe, expect, it, vi } from "vitest";

let mockRole = "admin";
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: 1, name: "Ada Admin", role: mockRole, teamMemberId: 9, isSuperAdmin: false, guardedActionsEnabled: false },
    logout: vi.fn(),
  }),
}));
vi.mock("@/lib/queryClient", () => ({
  apiRequest: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  queryClient: { invalidateQueries: vi.fn() },
}));

import Layout from "../../client/src/pages/Layout";
import { consumeLeadsAddIntent } from "../../client/src/lib/leadsFilterHandoff";

beforeAll(() => {
  // cmdk scrolls the selected row into view and watches the list's size;
  // jsdom has neither layout nor ResizeObserver.
  Element.prototype.scrollIntoView = vi.fn();
  class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver ??= ResizeObserverStub;
});

function renderLayout(role: string) {
  mockRole = role;
  window.location.hash = "#/";
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: ({ queryKey }) => Promise.resolve(String(queryKey[0]).includes("territory") ? [] : {}),
      },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Layout><div /></Layout>
    </QueryClientProvider>,
  );
}

const palette = () => screen.getByRole("dialog", { name: "Search or jump to a page" });

describe("command palette", () => {
  it("opens on Cmd-K, lists this role's pages, and closes on Escape", async () => {
    renderLayout("admin");
    expect(screen.queryByRole("dialog", { name: "Search or jump to a page" })).toBeNull();

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = palette();
    expect(within(dialog).getByTestId("palette-page-rulebook")).toBeInTheDocument();
    expect(within(dialog).getByTestId("palette-page-commission-console")).toBeInTheDocument();
    expect(within(dialog).getByTestId("palette-action-add-lead")).toBeInTheDocument();

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search or jump to a page" })).toBeNull());
  });

  it("never offers a rep a page the sidebar would not", () => {
    renderLayout("rep");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const dialog = palette();
    expect(within(dialog).queryByTestId("palette-page-rulebook")).toBeNull();
    expect(within(dialog).queryByTestId("palette-page-commission-console")).toBeNull();
    expect(within(dialog).queryByTestId("palette-action-add-lead")).toBeNull();
    expect(within(dialog).getByTestId("palette-page-my-commission")).toBeInTheDocument();
    expect(within(dialog).getByTestId("palette-action-next-door")).toBeInTheDocument();
  });

  it("opens from the sidebar field and navigates through the hash router", async () => {
    renderLayout("admin");
    fireEvent.click(screen.getByTestId("palette-trigger"));
    const dialog = palette();
    fireEvent.click(within(dialog).getByTestId("palette-page-leads"));
    await waitFor(() => expect(window.location.hash).toBe("#/leads"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search or jump to a page" })).toBeNull());
  });

  it("hands the Add a lead intent to the Leads page", async () => {
    renderLayout("manager");
    fireEvent.keyDown(window, { key: "K", metaKey: true });
    fireEvent.click(within(palette()).getByTestId("palette-action-add-lead"));
    await waitFor(() => expect(window.location.hash).toBe("#/leads"));
    expect(consumeLeadsAddIntent()).toBe(true);
    // One-shot: a later visit does not re-open the dialog.
    expect(consumeLeadsAddIntent()).toBe(false);
  });

  it("claims only the K chord", () => {
    renderLayout("admin");
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    fireEvent.keyDown(window, { key: "k" });
    fireEvent.keyDown(window, { key: "k", metaKey: true, shiftKey: true });
    expect(screen.queryByRole("dialog", { name: "Search or jump to a page" })).toBeNull();
  });

  it("shows the breadcrumb for the active page on desktop", () => {
    renderLayout("admin");
    const crumb = screen.getByTestId("breadcrumb-bar");
    expect(crumb).toHaveTextContent("Core");
    expect(crumb).toHaveTextContent("Dashboard");
  });
});

describe("palette ranking", () => {
  it("prefers a word prefix over a fuzzy scatter, so Enter opens what was typed", async () => {
    const { rankEntry } = await import("../../client/src/components/CommandPalette");
    expect(rankEntry("Rulebook Governance /rulebook", "rule")).toBeGreaterThan(rankEntry("Field Hours Field /clock", "rule"));
    expect(rankEntry("Field Hours Field /clock", "rule")).toBe(0);
    expect(rankEntry("Team Metrics Metrics /metrics/team", "team met")).toBeGreaterThan(0);
    expect(rankEntry("Commissions & Pay Manage /commission-console", "pay")).toBeGreaterThan(0);
    expect(rankEntry("Anything", "")).toBe(1);
  });
});
