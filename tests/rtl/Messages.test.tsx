// The Messages screen — the org's only broadcast surface, and the sent log that
// keeps a manager from saying the same thing twice.
//
// Two things here are worth pinning against regression:
//   · READ, not delivered. The count is how many people opened the feed. A
//     delivery number would read as attention and is not the same thing.
//   · Retracting is confirmed, and the confirmation TELLS THE TRUTH about push:
//     a phone that already buzzed cannot be unbuzzed, and a manager who believes
//     otherwise will not follow up with the floor.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockAuth, apiRequest, toast } = vi.hoisted(() => ({
  mockAuth: { user: { id: 1, name: "Mo Manager", role: "manager", teamMemberId: 3 } as any },
  apiRequest: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => mockAuth }));
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: { invalidateQueries: vi.fn() },
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

import Messages from "../../client/src/pages/Messages";

const NOW = Date.now();
const sent = [
  {
    id: 42, kind: "promo", headline: "Double spiffs tonight",
    body: "Every close after 5 PM pays twice.", amountCents: 5000,
    actorName: "Mo M.", createdAtMs: NOW - 5 * 60_000, readCount: 8, audience: 14,
  },
  {
    id: 41, kind: "update", headline: "Door drops are live",
    body: "Any verified door can now drop a bonus.",
    actorName: "Mo M.", createdAtMs: NOW - 3 * 3_600_000, readCount: 14, audience: 14,
  },
];

function renderPage(items: any[] = sent) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: async ({ queryKey }) => {
          if (String(queryKey[0]).includes("/api/announcements/sent")) return { items };
          return {};
        },
      },
    },
  });
  return render(<QueryClientProvider client={qc}><Messages /></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.user = { id: 1, name: "Mo Manager", role: "manager", teamMemberId: 3 };
  apiRequest.mockResolvedValue({ json: async () => ({ ok: true }) });
});

describe("Messages", () => {
  it("puts the composer and the sent log on one screen", async () => {
    renderPage();
    expect(screen.getByTestId("announcement-composer")).toBeInTheDocument();
    expect(await screen.findByTestId("sent-item-42")).toBeInTheDocument();
    expect(screen.getByTestId("sent-item-41")).toBeInTheDocument();
  });

  it("reports how many READ it, out of the org", async () => {
    renderPage();
    const row = await screen.findByTestId("sent-item-42");
    expect(within(row).getByTestId("sent-read-count")).toHaveTextContent("8 of 14 read");
  });

  it("labels the delivery choice on each past post", async () => {
    renderPage();
    expect(within(await screen.findByTestId("sent-item-42")).getByText("Promo")).toBeInTheDocument();
    expect(within(screen.getByTestId("sent-item-41")).getByText("Update")).toBeInTheDocument();
  });

  it("shows a promo's advertised amount", async () => {
    renderPage();
    expect(within(await screen.findByTestId("sent-item-42")).getByText("$50")).toBeInTheDocument();
  });

  it("says what will fill an empty log rather than looking broken", async () => {
    renderPage([]);
    expect(await screen.findByTestId("sent-log-empty")).toHaveTextContent(/nothing sent yet/i);
  });

  it("confirms before retracting, and is honest that push cannot be recalled", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("sent-delete-42"));

    const dialog = await screen.findByTestId("sent-delete-confirm");
    expect(within(dialog).getByText(/can't be unbuzzed/i)).toBeInTheDocument();
    // Nothing has been sent to the server on merely opening the confirmation.
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("does not warn about push when retracting a feed-only update", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("sent-delete-41"));

    const dialog = await screen.findByTestId("sent-delete-confirm");
    expect(within(dialog).queryByText(/unbuzzed/i)).not.toBeInTheDocument();
  });

  it("retracts through the API once confirmed", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("sent-delete-42"));
    await user.click(await screen.findByRole("button", { name: "Retract" }));

    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith("DELETE", "/api/announcements/42");
    });
  });

  it("keeps the post when the manager backs out", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("sent-delete-42"));
    await user.click(await screen.findByRole("button", { name: "Keep it" }));

    expect(apiRequest).not.toHaveBeenCalled();
    expect(screen.getByTestId("sent-item-42")).toBeInTheDocument();
  });

  it("points a rep at the bell instead of showing them a composer", async () => {
    mockAuth.user = { id: 5, name: "Rae Rep", role: "rep", teamMemberId: 9 };
    renderPage();
    expect(await screen.findByTestId("messages-no-access")).toBeInTheDocument();
    expect(screen.queryByTestId("announcement-composer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sent-log")).not.toBeInTheDocument();
  });
});
