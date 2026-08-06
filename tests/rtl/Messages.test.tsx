// The Messages hub — one place for every conversation, three panes.
//
// What is pinned here:
//   · The chat tab is LIST-FIRST: the floor pinned on top, DMs and groups
//     under it, each named and badged. Opening a room is one tap.
//   · The MEGAPHONE did not open with the door: a manager's announcements tab
//     is the composer + sent log; a rep's is the read-only feed. Group
//     creation shows only to megaphone holders.
//   · A DM offers NO moderation to anyone — a manager sees a delete on their
//     own words and nobody else's.
//   · Drafts survive room and tab switches — the hub holds them, not the pane.
//   · The sent log's contracts survive it all — READ (not delivered) counts,
//     and a retraction that tells the truth about push.
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
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

const chatPage = {
  items: [
    { id: 1, authorUserId: 9, authorMemberId: 7, authorName: "Rae R.", body: "morning floor", createdAtMs: NOW - 10 * 60_000 },
    { id: 2, authorUserId: 1, authorMemberId: 3, authorName: "Mo M.", body: "big push tonight", createdAtMs: NOW - 5 * 60_000 },
  ],
  unread: 1,
  latestId: 2,
  threadsUnread: 2,
};

const dmThread = {
  id: 9, kind: "dm", name: null, createdByUserId: 1,
  members: [
    { userId: 1, memberId: 3, name: "Mo M." },
    { userId: 9, memberId: 7, name: "Rae R." },
  ],
  unread: 2, latestId: 31,
  lastMessage: { authorUserId: 9, authorName: "Rae R.", body: "got a sec?", createdAtMs: NOW - 2 * 60_000 },
};

const groupThread = {
  id: 12, kind: "group", name: "Lexington crew", createdByUserId: 1,
  members: [
    { userId: 1, memberId: 3, name: "Mo M." },
    { userId: 9, memberId: 7, name: "Rae R." },
    { userId: 11, memberId: 8, name: "Bo R." },
  ],
  unread: 0, latestId: 40,
  lastMessage: { authorUserId: 1, authorName: "Mo M.", body: "push at 6", createdAtMs: NOW - 3_600_000 },
};

const dmPage = {
  items: [
    { id: 31, authorUserId: 9, authorMemberId: 7, authorName: "Rae R.", body: "got a sec?", createdAtMs: NOW - 2 * 60_000 },
  ],
  unread: 2, latestId: 31,
};

const feed = {
  items: [
    { id: 8, kind: "sale", actorRepId: 7, actorName: "Rae R.", headline: "Rae R. just closed one on Maple", body: "2 on the board today.", createdAtMs: NOW - 20 * 60_000 },
  ],
  unread: 1,
  latestId: 8,
};

const board = [
  { rep: { id: 7, name: "Rae Rep", role: "rep" }, knocks: 30, contacts: 9, callbacks: 2, sales: 4 },
  { rep: { id: 3, name: "Mo Manager", role: "manager" }, knocks: 10, contacts: 4, callbacks: 1, sales: 2 },
  { rep: { id: 8, name: "Bo Rep", role: "rep" }, knocks: 12, contacts: 3, callbacks: 0, sales: 1 },
  { rep: { id: 9, name: "Cy Rep", role: "rep" }, knocks: 8, contacts: 2, callbacks: 0, sales: 0 },
];

const roster = [
  { id: 3, name: "Mo Manager", role: "manager", color: "#F97316" },
  { id: 7, name: "Rae Rep", role: "rep", color: "#2563EB" },
];

function renderPage(overrides: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    "/api/chat": chatPage,
    "/api/team": roster,
    "/api/announcements/sent": { items: sent },
    "/api/announcements": feed,
    "/api/chat/threads": { threads: [dmThread, groupThread] },
    ...overrides,
  };
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: async ({ queryKey }) => {
          const url = String(queryKey[0]);
          if (url.startsWith("/api/leaderboard")) return board;
          if (url.startsWith("/api/chat/threads/")) {
            const v = data["/api/chat/threads/*"] ?? dmPage;
            if (v instanceof Error) throw v; // simulate a vanished room
            return v;
          }
          if (url.startsWith("/api/announcements/sent")) return data["/api/announcements/sent"];
          for (const k of Object.keys(data)) if (url === k || url.startsWith(`${k}?`)) return data[k];
          return {};
        },
      },
    },
  });
  const { hook } = memoryLocation({ path: "/messages" });
  return render(
    <Router hook={hook}>
      <QueryClientProvider client={qc}><Messages /></QueryClientProvider>
    </Router>,
  );
}

/** Every room test starts from the list — that IS the chat tab now. */
async function openFloor(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId("thread-floor"));
  await screen.findByTestId("chat-room");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.user = { id: 1, name: "Mo Manager", role: "manager", teamMemberId: 3 };
  apiRequest.mockResolvedValue({ json: async () => ({ ok: true }) });
});

describe("Messages hub — the conversation list", () => {
  it("opens on the list: floor pinned, DMs named after the other person, groups by name", async () => {
    renderPage();
    expect(await screen.findByTestId("chat-thread-list")).toBeInTheDocument();
    expect(screen.getByTestId("thread-floor")).toHaveTextContent("The floor");
    expect(await screen.findByTestId("thread-9")).toHaveTextContent("Rae R.");
    expect(screen.getByTestId("thread-9")).toHaveTextContent("got a sec?");
    expect(screen.getByTestId("thread-12")).toHaveTextContent("Lexington crew");
  });

  it("badges each row with its own unread, and the floor with its own", async () => {
    renderPage();
    expect(await screen.findByTestId("thread-9-unread")).toHaveTextContent("2");
    expect(screen.getByTestId("thread-floor-unread")).toHaveTextContent("1");
    expect(screen.queryByTestId("thread-12-unread")).toBeNull();
  });

  it("sums floor + threads on the chat tab badge", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId("tab-board"));
    // unread 1 on the floor + 2 across threads.
    expect(await screen.findByTestId("tab-chat-unread")).toHaveTextContent("3");
  });
});

describe("Messages hub — the floor room", () => {
  it("opens from the list and renders the conversation", async () => {
    const user = userEvent.setup();
    renderPage();
    await openFloor(user);
    expect(await screen.findByTestId("chat-message-1")).toHaveTextContent("morning floor");
    expect(screen.getByTestId("chat-message-2")).toHaveTextContent("big push tonight");
    expect(within(screen.getByTestId("chat-message-1")).getByText("Rae R.")).toBeInTheDocument();
  });

  it("sends through apiRequest and clears the box", async () => {
    const user = userEvent.setup();
    renderPage();
    await openFloor(user);
    const input = await screen.findByTestId("chat-input");
    await user.type(input, "on my way");
    await user.click(screen.getByTestId("chat-send"));
    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith("POST", "/api/chat", { body: "on my way" });
    });
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  it("marks the room read on open — the badge and the room agree", async () => {
    const user = userEvent.setup();
    renderPage();
    await openFloor(user);
    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith("POST", "/api/chat/read", { upToId: 2 });
    });
  });

  it("keeps a half-typed draft through a trip to the board and back", async () => {
    const user = userEvent.setup();
    renderPage();
    await openFloor(user);
    await user.type(await screen.findByTestId("chat-input"), "half a thought");
    await user.click(screen.getByTestId("tab-board"));
    await screen.findByTestId("board-panel");
    await user.click(screen.getByTestId("tab-chat"));
    expect(((await screen.findByTestId("chat-input")) as HTMLTextAreaElement).value).toBe("half a thought");
  });

  it("tells someone how far OVER the limit they are, in the validator's words", async () => {
    const user = userEvent.setup();
    renderPage();
    await openFloor(user);
    const input = (await screen.findByTestId("chat-input")) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "x".repeat(2050) } });
    expect(screen.getByTestId("chat-char-count")).toHaveTextContent("50 over");
    expect(screen.getByTestId("chat-error")).toHaveTextContent(/over 2000 characters/i);
    expect(screen.getByTestId("chat-send")).toBeDisabled();
  });

  it("lets a manager moderate the floor, after a confirmation", async () => {
    const user = userEvent.setup();
    renderPage();
    await openFloor(user);
    await user.click(await screen.findByTestId("chat-delete-1"));
    expect(await screen.findByTestId("chat-delete-confirm")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith("DELETE", "/api/chat/1");
    });
  });

  it("offers a rep deletes on their own words only", async () => {
    mockAuth.user = { id: 9, name: "Rae Rep", role: "rep", teamMemberId: 7 };
    const user = userEvent.setup();
    renderPage();
    await openFloor(user);
    await screen.findByTestId("chat-message-1");
    expect(screen.getByTestId("chat-delete-1")).toBeInTheDocument();   // hers
    expect(screen.queryByTestId("chat-delete-2")).toBeNull();          // the manager's
  });
});

describe("Messages hub — DMs and groups", () => {
  it("opens a DM named after the other person, and offers NO moderation inside it", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("thread-9"));
    expect(await screen.findByTestId("chat-room-title")).toHaveTextContent("Rae R.");
    // Rae's message, in the manager's DM: the manager holds the moderation
    // capability and still gets no delete — a DM is not theirs to moderate.
    await screen.findByTestId("chat-message-31");
    expect(screen.queryByTestId("chat-delete-31")).toBeNull();
    expect(screen.getByTestId("chat-back")).toBeInTheDocument();
  });

  it("shows a group's name, crew, and members sheet", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("thread-12"));
    expect(await screen.findByTestId("chat-room-title")).toHaveTextContent("Lexington crew");
    await user.click(screen.getByTestId("chat-members"));
    const sheet = await screen.findByTestId("group-members-sheet");
    expect(within(sheet).getByTestId("group-member-9")).toHaveTextContent("Rae R.");
    // A manager can re-crew from here.
    expect(within(sheet).getByTestId("group-remove-9")).toBeInTheDocument();
  });

  it("routes a thread send to that thread's endpoint", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("thread-9"));
    await user.type(await screen.findByTestId("chat-input"), "sure, call me");
    await user.click(screen.getByTestId("chat-send"));
    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith("POST", "/api/chat/threads/9", { body: "sure, call me" });
    });
  });

  it("starts a DM from the roster in one tap", async () => {
    apiRequest.mockResolvedValue({ json: async () => ({ threadId: 9 }) });
    mockAuth.user = { id: 9, name: "Rae Rep", role: "rep", teamMemberId: 7 };
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("thread-new"));
    // A rep gets no group builder — that is the megaphone's power.
    expect(screen.queryByTestId("new-thread-group")).toBeNull();
    await user.click(await screen.findByTestId("pick-member-3"));
    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith("POST", "/api/chat/threads", { kind: "dm", memberId: 3 });
    });
  });

  it("says so plainly when the room is gone, instead of a quiet fake room", async () => {
    const gone = Object.assign(new Error("404: Not found"), { status: 404 });
    const user = userEvent.setup();
    renderPage({ "/api/chat/threads/*": gone });
    await user.click(await screen.findByTestId("thread-9"));
    expect(await screen.findByTestId("chat-room-gone")).toHaveTextContent(/no longer in this conversation/i);
    await user.click(screen.getByTestId("chat-room-gone-back"));
    expect(await screen.findByTestId("chat-thread-list")).toBeInTheDocument();
  });

  it("confirms before a manager removes someone from a group", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("thread-12"));
    await user.click(await screen.findByTestId("chat-members"));
    await user.click(await screen.findByTestId("group-remove-9"));
    const dialog = await screen.findByTestId("group-remove-confirm");
    expect(within(dialog).getByText(/Remove Rae R\./)).toBeInTheDocument();
    expect(apiRequest).not.toHaveBeenCalledWith("POST", "/api/chat/threads/12/members", expect.anything());
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith("POST", "/api/chat/threads/12/members", { removeUserIds: [9] });
    });
  });

  it("offers no remove on your own row — leaving is its own, confirmed act", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("thread-12"));
    await user.click(await screen.findByTestId("chat-members"));
    await screen.findByTestId("group-member-1");
    expect(screen.queryByTestId("group-remove-1")).toBeNull(); // the manager themselves
    await user.click(screen.getByTestId("group-leave"));
    const dialog = await screen.findByTestId("group-leave-confirm");
    await user.click(within(dialog).getByRole("button", { name: "Leave" }));
    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith("POST", "/api/chat/threads/12/leave");
    });
  });

  it("lets a manager disband a group, behind a confirm that says what it costs", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("thread-12"));
    await user.click(await screen.findByTestId("chat-members"));
    await user.click(await screen.findByTestId("group-disband"));
    const dialog = await screen.findByTestId("group-disband-confirm");
    expect(within(dialog).getByText(/for everyone, for good/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Disband" }));
    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith("DELETE", "/api/chat/threads/12");
    });
  });

  it("hides the whole crew-management surface from a rep", async () => {
    mockAuth.user = { id: 9, name: "Rae Rep", role: "rep", teamMemberId: 7 };
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("thread-12"));
    await user.click(await screen.findByTestId("chat-members"));
    await screen.findByTestId("group-member-1");
    expect(screen.queryByTestId("group-remove-1")).toBeNull();
    expect(screen.queryByTestId("group-disband")).toBeNull();
    expect(screen.getByTestId("group-leave")).toBeInTheDocument(); // leaving is theirs
  });

  it("lets a megaphone holder build a named group", async () => {
    apiRequest.mockResolvedValue({ json: async () => ({ threadId: 12 }) });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("thread-new"));
    await user.click(await screen.findByTestId("new-thread-group"));
    await user.type(screen.getByTestId("group-name"), "Northside");
    await user.click(screen.getByTestId("pick-member-7"));
    await user.click(screen.getByTestId("group-create"));
    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith("POST", "/api/chat/threads", { kind: "group", name: "Northside", memberIds: [7] });
    });
  });
});

describe("Messages hub — announcements tab", () => {
  it("gives a manager the composer and the sent log", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId("tab-announcements"));
    expect(screen.getByTestId("announcement-composer")).toBeInTheDocument();
    expect(await screen.findByTestId("sent-item-42")).toBeInTheDocument();
    expect(screen.queryByTestId("announcement-feed")).toBeNull();
  });

  it("still reports READ counts, out of the org", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId("tab-announcements"));
    const row = await screen.findByTestId("sent-item-42");
    expect(within(row).getByTestId("sent-read-count")).toHaveTextContent("8 of 14 read");
  });

  it("still confirms a retraction with the truth about push", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId("tab-announcements"));
    await user.click(await screen.findByTestId("sent-delete-42"));
    const dialog = await screen.findByTestId("sent-delete-confirm");
    expect(within(dialog).getByText(/can't be unbuzzed/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Retract" }));
    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith("DELETE", "/api/announcements/42");
    });
  });

  it("gives a rep the feed, never the megaphone", async () => {
    mockAuth.user = { id: 9, name: "Rae Rep", role: "rep", teamMemberId: 7 };
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId("tab-announcements"));
    expect(await screen.findByTestId("announcement-feed")).toBeInTheDocument();
    expect(screen.getByTestId("feed-item-8")).toHaveTextContent(/closed one on Maple/);
    expect(screen.queryByTestId("announcement-composer")).toBeNull();
    expect(screen.queryByTestId("sent-log")).toBeNull();
  });

  it("carries the feed's unread count on a rep's tab until it is opened", async () => {
    mockAuth.user = { id: 9, name: "Rae Rep", role: "rep", teamMemberId: 7 };
    renderPage();
    expect(await screen.findByTestId("tab-announcements-unread")).toHaveTextContent("1");
  });

  it("keeps a manager's feed count on the bell, not on a tab that reads nothing", async () => {
    renderPage();
    await screen.findByTestId("chat-thread-list");
    expect(screen.queryByTestId("tab-announcements-unread")).toBeNull();
  });
});

describe("Messages hub — the board", () => {
  it("shows the podium, the chasers, and where you stand", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId("tab-board"));
    const podium1 = await screen.findByTestId("board-podium-1");
    expect(podium1).toHaveTextContent("Rae Rep");
    expect(podium1).toHaveTextContent("4");
    expect(screen.getByTestId("board-row-9")).toBeInTheDocument();
    expect(screen.getByTestId("board-me")).toHaveTextContent("#2 of 4");
  });

  it("links to the full leaderboard", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId("tab-board"));
    expect(await screen.findByTestId("board-full-link")).toHaveAttribute("href", "/leaderboard");
  });
});
