import { activateWork, purgeWork } from "@/lib/workAuthority";
// RTL tests for the CE-2 field coaching engine: drill-card flip, deck grade
// flow (outbox + optimistic advance), the fully-offline deck from the local
// corpus, the WhatNext objection lookup, WarmupStrip due count, and the
// ladder bar. Server API shapes are the CE-1 contract, mocked here.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { buildDrillDeck, cardsByObjection, type DrillCard } from "@shared/trainingCards";
import { DailyDrillCard } from "@/components/training/DailyDrillCard";
import { FlashcardDeck } from "@/components/training/FlashcardDeck";
import { WhatNextSheet } from "@/components/training/WhatNextSheet";
import { WarmupStrip } from "@/components/training/WarmupStrip";
import { LadderBar } from "@/components/training/LadderBar";
import { DebriefCard } from "@/components/training/DebriefCard";
import Coach from "@/pages/Coach";
import { useDueCards, useRecordReviews } from "@/lib/useTrainingEngine";
import { getTrainingReviewQueue } from "@/lib/trainingReviewQueue";

// The engine hooks read the signed-in rep via useAuth; pin one rep.
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: 7, name: "Field Rep", email: "rep@example.com", role: "rep", teamMemberId: 42 },
  }),
}));

beforeAll(() => {
  if (!window.HTMLElement.prototype.scrollIntoView) {
    window.HTMLElement.prototype.scrollIntoView = () => {};
  }
  if (!window.matchMedia) {
    (window as any).matchMedia = () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    });
  }
});

const DECK = buildDrillDeck();
const TWO_CARDS: DrillCard[] = [DECK[0], DECK[1]];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** fetch mock speaking the CE-1 contract. */
function mockFetch(opts: { offline?: boolean } = {}) {
  const calls: { url: string; method: string; body?: any }[] = [];
  const fn = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (opts.offline) throw new TypeError("Failed to fetch");
    if (url.includes("/api/training/reviews")) return jsonResponse({ ok: true, updated: body?.reviews?.length ?? 0 });
    if (url.includes("/api/training/deck")) {
      return jsonResponse({ due: TWO_CARDS, new: [], dueCount: 2, newCount: 0 });
    }
    if (url.includes("/api/training/coach-summary")) {
      return jsonResponse({
        dueCount: 2, newCount: 0, streakDays: 3,
        ladderCoverage: { "0": 1, "1": 1, "2": 0, "3": 0, "4": 0 },
        totalCards: DECK.length, cardsReviewedTotal: 5,
      });
    }
    return jsonResponse({}, 404);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  purgeWork(); window.localStorage.clear();
  activateWork({ userId: 7, tenantId: null, teamMemberId: 42 }, "coach-test-session");
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});

afterEach(async () => {
  // Let every in-flight query settle BEFORE unmount/cleanup — destroying a
  // query mid-fetch surfaces as an unhandled rejection in the offline tests.
  await waitFor(() => expect(qc.isFetching()).toBe(0)).catch(() => {});
  // Tear down the singleton outbox so no timer/listener leaks between tests.
  getTrainingReviewQueue({ ownerKey: 42, owner: { userId: 7, tenantId: null, teamMemberId: 42 }, post: async () => ({}) }).destroy();
  purgeWork();
  vi.unstubAllGlobals();
});

// 1. DailyDrillCard: tap-to-flip
describe("DailyDrillCard", () => {
  it("flips front to back on tap with an accessible pressed state", () => {
    const card = TWO_CARDS[0];
    let flipped = false;
    const onFlip = vi.fn(() => { flipped = !flipped; });
    const { rerender } = render(<DailyDrillCard card={card} flipped={flipped} onFlip={onFlip} />);

    const el = screen.getByTestId(`drill-card-${card.id}`);
    expect(el).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("drill-card-front")).toBeInTheDocument();

    fireEvent.click(el);
    expect(onFlip).toHaveBeenCalledTimes(1);

    rerender(<DailyDrillCard card={card} flipped={true} onFlip={onFlip} />);
    expect(screen.getByTestId(`drill-card-${card.id}`)).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("drill-card-back")).toBeInTheDocument();
    // The back carries the source-lesson link (44px floor).
    expect(screen.getByTestId(`drill-card-source-${card.id}`)).toBeInTheDocument();
  });
});

// 2. FlashcardDeck: grade flow
describe("FlashcardDeck", () => {
  it("requires the reveal before grading, advances on grade, and finishes", () => {
    const onGrade = vi.fn();
    const onDone = vi.fn();
    render(<FlashcardDeck cards={TWO_CARDS} mode="warmup" onGrade={onGrade} onExit={() => {}} onDone={onDone} />);

    // Grade buttons exist with aria labels but stay disabled until the flip.
    const good = screen.getByTestId("grade-good");
    expect(good).toHaveAttribute("aria-label", "Grade this card: Good");
    expect(good).toBeDisabled();

    fireEvent.click(screen.getByTestId(`drill-card-${TWO_CARDS[0].id}`));
    expect(good).toBeEnabled();
    fireEvent.click(good);

    expect(onGrade).toHaveBeenCalledWith(TWO_CARDS[0], "good", "warmup");
    expect(screen.getByTestId("deck-progress")).toHaveTextContent("2 of 2");

    fireEvent.click(screen.getByTestId(`drill-card-${TWO_CARDS[1].id}`));
    fireEvent.click(screen.getByTestId("grade-easy"));
    expect(screen.getByTestId("deck-finished")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("deck-done"));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("re-deals an again card at the tail of the session pile", () => {
    const onGrade = vi.fn();
    render(<FlashcardDeck cards={TWO_CARDS} mode="warmup" onGrade={onGrade} onExit={() => {}} onDone={() => {}} />);

    fireEvent.click(screen.getByTestId(`drill-card-${TWO_CARDS[0].id}`));
    fireEvent.click(screen.getByTestId("grade-again"));
    expect(onGrade).toHaveBeenCalledWith(TWO_CARDS[0], "again", "warmup");
    // Card 2 next; the missed card is back at the tail (3 of 3).
    expect(screen.getByTestId("deck-progress")).toHaveTextContent("2 of 3");
  });

  it("refresher mode is two taps: Again / Got it mapped to real grades", () => {
    const onGrade = vi.fn();
    render(<FlashcardDeck cards={[TWO_CARDS[0]]} mode="refresher" onGrade={onGrade} onExit={() => {}} onDone={() => {}} />);
    expect(screen.queryByTestId("grade-hard")).not.toBeInTheDocument();
    expect(screen.getByTestId("grade-good")).toHaveTextContent("Got it");

    fireEvent.click(screen.getByTestId(`drill-card-${TWO_CARDS[0].id}`));
    fireEvent.click(screen.getByTestId("grade-good"));
    expect(onGrade).toHaveBeenCalledWith(TWO_CARDS[0], "good", "refresher");
  });

  it("grades enqueue to the outbox AND advance the cached deck optimistically", async () => {
    const calls = mockFetch();
    qc.setQueryData(["/api/training/deck"], { due: TWO_CARDS, new: [], dueCount: 2, newCount: 0 });

    function Harness() {
      const deck = useDueCards();
      const { recordReview } = useRecordReviews();
      if (deck.isLoading) return null;
      return (
        <FlashcardDeck
          cards={[...deck.due, ...deck.newCards]}
          mode="warmup"
          onGrade={(c, g) => recordReview(c, g)}
          onExit={() => {}}
          onDone={() => {}}
        />
      );
    }
    render(<Harness />, { wrapper });

    fireEvent.click(await screen.findByTestId(`drill-card-${TWO_CARDS[0].id}`));
    fireEvent.click(screen.getByTestId("grade-good"));

    // Outbox delivered the review in the CE-1 batch shape.
    await waitFor(() => {
      const post = calls.find((c) => c.url.includes("/api/training/reviews"));
      expect(post).toBeTruthy();
      expect(post!.body.reviews).toHaveLength(1);
      expect(post!.body.reviews[0]).toMatchObject({
        cardId: TWO_CARDS[0].id,
        grade: "good",
        rungBefore: 0,
      });
      expect(typeof post!.body.reviews[0].reviewedAt).toBe("string");
    });

    // Optimistic advance: the graded card left the cached due pile and the
    // shared ladder moved the card up one rung in the local map.
    const cached = qc.getQueryData(["/api/training/deck"]) as any;
    expect(cached.dueCount).toBe(1);
    expect(cached.due.map((c: DrillCard) => c.id)).toEqual([TWO_CARDS[1].id]);
    const ladder = JSON.parse(window.localStorage.getItem("hf.trainingLadder.v1.42")!);
    expect(ladder.rungs[TWO_CARDS[0].id]).toBe(1); // good: rung 0 to 1
    expect(ladder.reviewCount).toBe(1);
  });
});

// 3. Offline deck from the local corpus
describe("offline-first Coach", () => {
  it("deals a deck from the bundled corpus with zero network and no snapshot", async () => {
    mockFetch({ offline: true });
    render(<Coach />, { wrapper });

    // 10 new cards from the local corpus, honestly labeled, no crash.
    await screen.findByTestId("coach-due-count");
    expect(screen.getByTestId("coach-due-count")).toHaveTextContent("10");
    expect(screen.getByTestId("mode-strip-due")).toHaveTextContent("10 cards due");
    // Streak stays honest: nothing reviewed, so the quiet prompt, never a fake streak.
    expect(screen.getByTestId("coach-streak")).toHaveTextContent("Pick up where you left off");
    // The ladder bar renders from the empty local map over the full corpus.
    expect(screen.getByTestId("ladder-summary")).toHaveTextContent(`0 of ${DECK.length} cards on the ladder`);
  });

  it("runs a warmup deck offline: grades persist locally and queue for sync", async () => {
    mockFetch({ offline: true });
    render(<Coach />, { wrapper });
    fireEvent.click(await screen.findByTestId("mode-warmup"));

    const first = DECK[0];
    fireEvent.click(await screen.findByTestId(`drill-card-${first.id}`));
    fireEvent.click(screen.getByTestId("grade-good"));

    // The review is durably queued (outbox) even though every fetch fails.
    const queued = getTrainingReviewQueue({ ownerKey: 42, owner: { userId: 7, tenantId: null, teamMemberId: 42 }, post: async () => ({}) }).pending();
    expect(queued.some((r) => r.cardId === first.id && r.grade === "good")).toBe(true);
    // And the deck advanced to the next card.
    expect(screen.getByTestId("deck-progress")).toHaveTextContent("2 of 10");
  });
});

// 4. WhatNextSheet: objection lookup from the local corpus
describe("WhatNextSheet", () => {
  it("looks up the verbatim card for an objection in two taps, offline", () => {
    render(<WhatNextSheet open={true} onOpenChange={() => {}} />);

    // Default stage is Objection with the 14-key chip row.
    expect(screen.getByTestId("objection-chips")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("objection-chip-happy_provider"));

    const expected = cardsByObjection("happy_provider");
    expect(expected.length).toBeGreaterThan(0);
    const rendered = screen.getByTestId(`what-next-card-${expected[0].id}`);
    expect(rendered).toBeInTheDocument();
  });

  it("names the content gap honestly for keys with no card", () => {
    render(<WhatNextSheet open={true} onOpenChange={() => {}} />);
    fireEvent.click(screen.getByTestId("objection-chip-no_card"));
    expect(screen.getByTestId("what-next-gap")).toHaveTextContent("No drill card for this one yet");
  });

  it("non-objection stages render cards straight from the corpus", () => {
    render(<WhatNextSheet open={true} onOpenChange={() => {}} />);
    fireEvent.click(screen.getByTestId("stage-opener"));
    expect(screen.getAllByTestId(/what-next-card-/).length).toBeGreaterThan(0);
  });
});

// 5. WarmupStrip: due count entry card
describe("WarmupStrip", () => {
  it("shows the due + new count from the persisted deck snapshot", async () => {
    mockFetch();
    qc.setQueryData(["/api/training/deck"], { due: TWO_CARDS, new: [DECK[2]], dueCount: 2, newCount: 1 });
    render(<WarmupStrip />, { wrapper });
    const strip = await screen.findByTestId("warmup-strip");
    expect(strip).toHaveTextContent("3 cards before your first door");
  });

  it("renders nothing when nothing is due (no fake zero, no layout shift)", () => {
    mockFetch();
    qc.setQueryData(["/api/training/deck"], { due: [], new: [], dueCount: 0, newCount: 0 });
    const { container } = render(<WarmupStrip />, { wrapper });
    expect(container).toBeEmptyDOMElement();
  });
});

// 6. LadderBar
describe("LadderBar", () => {
  it("renders the 5 rungs with counts and an accessible summary", () => {
    render(<LadderBar coverage={{ "0": 4, "1": 3, "2": 2, "3": 1, "4": 0 }} totalCards={20} />);
    expect(screen.getByTestId("ladder-bar")).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("4 cards on rung New"),
    );
    expect(screen.getByTestId("ladder-summary")).toHaveTextContent("10 of 20 cards on the ladder · 1 past a week");
  });
});

// 7. DebriefCard
describe("DebriefCard", () => {
  it("persists the one-line reflection and heard-objections locally", () => {
    render(<DebriefCard reviewedCount={4} onDone={() => {}} />);
    expect(screen.getByTestId("debrief-reviewed")).toHaveTextContent("4 cards drilled");

    fireEvent.click(screen.getByTestId("objection-chip-price"));
    expect(screen.getByTestId("debrief-heard-count")).toHaveTextContent("1 objection logged");

    const input = screen.getByTestId("debrief-reflection");
    fireEvent.change(input, { target: { value: "Slow down on the price reframe" } });
    fireEvent.blur(input);
    const day = new Date();
    const key = `hf.trainingReflection.v1.${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    expect(JSON.parse(window.localStorage.getItem(key)!)).toBe("Slow down on the price reframe");
  });
});
