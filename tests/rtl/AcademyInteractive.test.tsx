// The interactive Academy surfaces, end to end in the DOM.
//
// What matters here is what a rep would notice: a quiz that resumes where they
// stopped, an expired promotion that visibly stops being quotable, a Pitch Lab
// that refuses to fill in a price nobody configured, an objection drill that
// makes them answer before it reveals, and a role-play that talks back and
// produces a report without needing a microphone or a network.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: undefined,
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: 1, name: "Test Rep", role: "rep" } }),
}));

import ScenarioQuiz from "@/components/academy/ScenarioQuiz";
import BranchingConversation from "@/components/academy/BranchingConversation";
import ObjectionDojo from "@/components/academy/ObjectionDojo";
import PitchLab from "@/components/academy/PitchLab";
import ReferenceLibrary from "@/components/academy/ReferenceLibrary";
import RolePlayCoach from "@/components/academy/RolePlayCoach";
import ActivityComplete from "@/components/academy/ActivityComplete";
import { BRANCH_TREES, PATH_STAGES, SCENARIO_SETS, getActivity, getScenarioSet } from "@shared/academyPath";
import { certificationStatuses, computePathProgress, type ActivityRecord } from "@shared/academyProgress";
import { ACADEMY_OBJECTIONS } from "@shared/academyObjections";
import type { AcademyOffer } from "@shared/academyOffers";

beforeAll(() => {
  (window as any).matchMedia = (query: string) => ({
    matches: false, media: query,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {},
  });
  if (!(Element.prototype as any).scrollTo) (Element.prototype as any).scrollTo = () => {};
});

const LIVE_OFFER: AcademyOffer = {
  id: "gig", provider: "kinetic", market: "nc-lexington", name: "Kinetic Fiber 1 Gig",
  downloadMbps: 1000, uploadMbps: 1000, priceCents: 6999,
  promoPriceCents: null, promoMonths: null, termMonths: 0,
  equipmentCents: 0, installCents: 0, unlimitedData: true,
  effectiveFrom: "2026-01-01", effectiveTo: null,
  disclosures: ["Price and availability are confirmed at the address before any order is placed."],
};

const EXPIRED_OFFER: AcademyOffer = { ...LIVE_OFFER, id: "summer", name: "Summer Promo", effectiveTo: "2026-08-01" };

function jsonResponse(payload: any) {
  return Promise.resolve({ json: () => Promise.resolve(payload) });
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  apiRequest.mockReset();
  apiRequest.mockImplementation(() => jsonResponse({}));
});

// ── Progress persistence and resume ───────────────────────────────────────────

describe("scenario progress", () => {
  const set = getScenarioSet("scn-compliance")!;

  it("resumes at the first unanswered question", () => {
    wrap(
      <ScenarioQuiz
        set={set}
        activityId="act-compliance-scenario"
        resume={{ answers: { 0: set.questions[0].answerIndex } }}
        onComplete={() => {}}
        onExit={() => {}}
      />,
    );
    expect(screen.getByTestId("scenario-progress").textContent).toContain(`2 of ${set.questions.length}`);
  });

  it("autosaves state after an answer, so closing the app does not lose it", async () => {
    vi.useFakeTimers();
    try {
      wrap(<ScenarioQuiz set={set} activityId="act-compliance-scenario" resume={null} onComplete={() => {}} onExit={() => {}} />);
      fireEvent.click(screen.getByTestId(`scenario-q0-opt${set.questions[0].answerIndex}`));
      await act(async () => { vi.advanceTimersByTime(1500); });
      const put = apiRequest.mock.calls.find((c) => c[0] === "PUT" && String(c[1]).includes("/state"));
      expect(put).toBeTruthy();
      expect(put![2].state.answers[0]).toBe(set.questions[0].answerIndex);
    } finally {
      vi.useRealTimers();
    }
  });

  it("locks a question after one pick and shows the explanation either way", () => {
    wrap(<ScenarioQuiz set={set} activityId="act-compliance-scenario" resume={null} onComplete={() => {}} onExit={() => {}} />);
    const wrong = set.questions[0].answerIndex === 0 ? 1 : 0;
    fireEvent.click(screen.getByTestId(`scenario-q0-opt${wrong}`));
    expect(screen.getByTestId("scenario-q0-feedback").textContent).toContain("Not quite");
    // A second click changes nothing.
    fireEvent.click(screen.getByTestId(`scenario-q0-opt${set.questions[0].answerIndex}`));
    expect(screen.getByTestId("scenario-q0-feedback").textContent).toContain("Not quite");
  });

  it("hands up the score and offers a retry when the pass bar is not met", () => {
    const onComplete = vi.fn();
    wrap(
      <ScenarioQuiz set={set} activityId="act-compliance-scenario" resume={null} passScore={100} onComplete={onComplete} onExit={() => {}} />,
    );
    // Answer everything wrong.
    for (let i = 0; i < set.questions.length; i++) {
      const wrong = set.questions[i].answerIndex === 0 ? 1 : 0;
      fireEvent.click(screen.getByTestId(`scenario-q${i}-opt${wrong}`));
      if (i < set.questions.length - 1) fireEvent.click(screen.getByTestId("scenario-next"));
    }
    expect(screen.getByTestId("scenario-below-pass")).toBeTruthy();
    fireEvent.click(screen.getByTestId("scenario-finish"));
    expect(onComplete).toHaveBeenCalledWith(0);
  });

  it("reports the score honestly on a perfect run", () => {
    const onComplete = vi.fn();
    wrap(<ScenarioQuiz set={set} activityId="act-compliance-scenario" resume={null} passScore={100} onComplete={onComplete} onExit={() => {}} />);
    for (let i = 0; i < set.questions.length; i++) {
      fireEvent.click(screen.getByTestId(`scenario-q${i}-opt${set.questions[i].answerIndex}`));
      if (i < set.questions.length - 1) fireEvent.click(screen.getByTestId("scenario-next"));
    }
    expect(screen.getByTestId("scenario-result").textContent).toContain("100%");
    expect(screen.queryByTestId("scenario-below-pass")).toBeNull();
    fireEvent.click(screen.getByTestId("scenario-finish"));
    expect(onComplete).toHaveBeenCalledWith(100);
  });
});

// ── Expired content ───────────────────────────────────────────────────────────

describe("expired offers", () => {
  it("says the market has nothing quotable and why", () => {
    wrap(
      <ReferenceLibrary
        offers={[]} expired={[EXPIRED_OFFER]} competitors={[]}
        day="2026-08-10" market="nc-lexington" readCardIds={new Set()}
      />,
    );
    const empty = screen.getByTestId("offer-card-empty");
    expect(empty.textContent).toContain("No live offer today");
    expect(empty.textContent).toContain("2026-08-01");
    expect(empty.textContent).toContain("Do not quote");
  });

  it("shows live offers with their disclosures attached, not hidden", () => {
    wrap(
      <ReferenceLibrary
        offers={[LIVE_OFFER]} expired={[]} competitors={[]}
        day="2026-08-10" market="nc-lexington" readCardIds={new Set()}
      />,
    );
    const card = screen.getByTestId("offer-gig");
    expect(card.textContent).toContain("$69.99");
    expect(card.textContent).toContain("confirmed at the address");
  });

  it("counts what expired so a supervisor can see the market went quiet", () => {
    wrap(
      <ReferenceLibrary
        offers={[LIVE_OFFER]} expired={[EXPIRED_OFFER]} competitors={[]}
        day="2026-08-10" market="nc-lexington" readCardIds={new Set()}
      />,
    );
    expect(screen.getByTestId("offer-expired-note").textContent).toContain("1 offer expired");
  });

  it("marks a stale competitor figure unquotable", () => {
    wrap(
      <ReferenceLibrary
        offers={[LIVE_OFFER]} expired={[]} day="2026-08-10" market="nc-lexington" readCardIds={new Set()}
        competitors={[{
          id: "spectrum", provider: "spectrum", market: "*", name: "Spectrum 500",
          downloadMbps: 500, uploadMbps: 20, priceCents: 7999, medium: "cable",
          source: "Published rate card", asOf: "2025-01-01",
        }]}
      />,
    );
    expect(screen.getByTestId("reference-competitors").textContent).toContain("re-checks it");
  });
});

// ── Pitch Lab ─────────────────────────────────────────────────────────────────

describe("Pitch Lab", () => {
  it("warns when the market has no live offer and leaves price tokens visible", () => {
    wrap(<PitchLab activityId={null} resume={{ blockIds: ["ben-price-plain"] }} offer={null} />);
    expect(screen.getByTestId("pitch-lab-no-offer")).toBeTruthy();
    expect(screen.getByTestId("pitch-lab-blocks").textContent).toContain("{price}");
    expect(screen.getByTestId("pitch-lab-blocks").textContent).toContain("Do not say it");
  });

  it("fills the live figures in when the market has an offer", () => {
    wrap(<PitchLab activityId={null} resume={{ blockIds: ["ben-price-plain"] }} offer={LIVE_OFFER} />);
    expect(screen.queryByTestId("pitch-lab-no-offer")).toBeNull();
    expect(screen.getByTestId("pitch-lab-blocks").textContent).toContain("$69.99");
    expect(screen.getByTestId("pitch-lab-blocks").textContent).not.toContain("{price}");
  });

  it("names the structural problems in a half-built pitch", () => {
    wrap(<PitchLab activityId={null} resume={{ blockIds: ["intro-build-crew"] }} offer={LIVE_OFFER} />);
    const review = screen.getByTestId("pitch-lab-review").textContent ?? "";
    expect(review).toContain("No discovery question");
    expect(review).toContain("No close");
  });

  it("approves a sound pitch and surfaces its disclosures", () => {
    wrap(
      <PitchLab
        activityId={null}
        resume={{ blockIds: ["intro-build-crew", "disc-current-provider", "ben-price-plain", "close-two-slots"] }}
        offer={LIVE_OFFER}
      />,
    );
    expect(screen.getByTestId("pitch-lab-review").textContent).toContain("This one holds up");
    expect(screen.getByTestId("pitch-lab-disclosures").textContent).toContain("confirmed at the address");
  });

  it("reorders and removes blocks", () => {
    wrap(<PitchLab activityId={null} resume={{ blockIds: ["intro-build-crew", "close-two-slots"] }} offer={LIVE_OFFER} />);
    fireEvent.click(screen.getByTestId("pitch-up-1"));
    const first = screen.getByTestId("pitch-lab-blocks").querySelectorAll("li")[0];
    expect(first.textContent).toContain("Thursday");
    fireEvent.click(screen.getByTestId("pitch-remove-0"));
    expect(screen.getByTestId("pitch-lab-blocks").querySelectorAll("li")).toHaveLength(1);
  });

  it("shows the weak, better, excellent ladder on request", () => {
    wrap(<PitchLab activityId={null} resume={{ blockIds: [] }} offer={LIVE_OFFER} />);
    fireEvent.click(screen.getByTestId("pitch-compare-intro-build-crew"));
    const ladder = screen.getByTestId("pitch-ladder-intro-build-crew");
    expect(ladder.textContent).toContain("Weak");
    expect(ladder.textContent).toContain("Excellent");
    expect(ladder.textContent).toContain("Why the last one wins");
  });

  it("hands the assembled script to the recorder", () => {
    const onRehearse = vi.fn();
    wrap(
      <PitchLab
        activityId={null}
        resume={{ blockIds: ["intro-build-crew", "disc-current-provider", "ben-work-calls", "close-two-slots"] }}
        offer={LIVE_OFFER}
        onRehearse={onRehearse}
      />,
    );
    fireEvent.click(screen.getByTestId("pitch-lab-rehearse"));
    expect(onRehearse).toHaveBeenCalled();
    expect(onRehearse.mock.calls[0][0]).toContain("Thursday");
  });
});

// ── Objection dojo ────────────────────────────────────────────────────────────

describe("objection dojo", () => {
  it("lists all ten objections", () => {
    wrap(<ObjectionDojo completedKeys={new Set()} />);
    for (const objection of ACADEMY_OBJECTIONS) {
      expect(screen.getByTestId(`objection-${objection.key}`)).toBeTruthy();
    }
  });

  it("makes the rep answer out loud before it reveals anything", () => {
    wrap(<ObjectionDojo completedKeys={new Set()} />);
    fireEvent.click(screen.getByTestId("objection-price"));
    expect(screen.getByTestId("objection-answer-first")).toBeTruthy();
    // The ladder is not on screen yet.
    expect(screen.queryByTestId("objection-ladder-price")).toBeNull();

    fireEvent.click(screen.getByTestId("objection-reveal"));
    expect(screen.getByTestId("objection-ladder-price")).toBeTruthy();
    expect(screen.getByTestId("objection-trap")).toBeTruthy();
  });

  it("marks a drilled objection done and reports the count", () => {
    const onComplete = vi.fn();
    wrap(<ObjectionDojo completedKeys={new Set(["price", "renter"])} onComplete={onComplete} />);
    expect(screen.getByText(`2 of ${ACADEMY_OBJECTIONS.length}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId("objection-spouse"));
    fireEvent.click(screen.getByTestId("objection-reveal"));
    fireEvent.click(screen.getByTestId("objection-complete"));
    expect(onComplete).toHaveBeenCalledWith("spouse");
  });

  it("keeps the technique reference behind a disclosure toggle", () => {
    wrap(<ObjectionDojo completedKeys={new Set()} />);
    expect(screen.queryByTestId("objection-techniques")).toBeNull();
    fireEvent.click(screen.getByTestId("objection-techniques-toggle"));
    expect(screen.getByTestId("objection-techniques").textContent).toContain("Honest loss aversion");
  });
});

// ── Branching conversation ────────────────────────────────────────────────────

describe("branching conversation", () => {
  const tree = BRANCH_TREES[0];

  it("opens on the customer's line with the scene set", () => {
    wrap(<BranchingConversation tree={tree} activityId="act-branch-busy" resume={null} onComplete={() => {}} onExit={() => {}} />);
    expect(screen.getByTestId(`branching-${tree.id}`).textContent).toContain(tree.setup);
  });

  it("shows why a weak choice was weak, then reaches an outcome", () => {
    wrap(<BranchingConversation tree={tree} activityId="act-branch-busy" resume={null} onComplete={() => {}} onExit={() => {}} />);
    const start = tree.nodes.find((n) => n.id === tree.startNodeId)!;
    const weakIndex = start.options!.findIndex((o) => o.quality === "poor");
    fireEvent.click(screen.getByTestId(`branching-option-${weakIndex}`));
    expect(screen.getByTestId("branching-step-0").textContent).toContain("Weak choice");
    expect(screen.getByTestId("branching-outcome").textContent).toContain("Door closed");
  });

  it("scores a strong path higher than a weak one", () => {
    const onComplete = vi.fn();
    const { unmount } = wrap(
      <BranchingConversation tree={tree} activityId="act-branch-busy" resume={null} onComplete={onComplete} onExit={() => {}} />,
    );
    const start = tree.nodes.find((n) => n.id === tree.startNodeId)!;
    const strongIndex = start.options!.findIndex((o) => o.quality === "strong");
    fireEvent.click(screen.getByTestId(`branching-option-${strongIndex}`));
    // Keep taking strong options until it terminates.
    for (let i = 0; i < 5; i++) {
      const next = screen.queryAllByTestId(/^branching-option-/);
      if (!next.length) break;
      fireEvent.click(next[next.length - 1]);
    }
    fireEvent.click(screen.getByTestId("branching-finish"));
    expect(onComplete.mock.calls[0][0]).toBeGreaterThanOrEqual(65);
    unmount();
  });

  it("lets the rep take the other branch without leaving", () => {
    wrap(<BranchingConversation tree={tree} activityId="act-branch-busy" resume={null} onComplete={() => {}} onExit={() => {}} />);
    const start = tree.nodes.find((n) => n.id === tree.startNodeId)!;
    fireEvent.click(screen.getByTestId(`branching-option-${start.options!.findIndex((o) => o.quality === "poor")}`));
    fireEvent.click(screen.getByTestId("branching-restart"));
    expect(screen.queryByTestId("branching-outcome")).toBeNull();
    expect(screen.getByTestId("branching-option-0")).toBeTruthy();
  });
});

// ── Role-play ─────────────────────────────────────────────────────────────────

describe("role-play coach", () => {
  function renderCoach(props: Partial<React.ComponentProps<typeof RolePlayCoach>> = {}) {
    return wrap(
      <RolePlayCoach
        offers={[LIVE_OFFER]}
        market="nc-lexington"
        onBack={() => {}}
        {...props}
      />,
    );
  }

  it("offers all ten doors to pick from", () => {
    renderCoach();
    expect(screen.getByTestId("roleplay-picker")).toBeTruthy();
    expect(screen.getByTestId("roleplay-persona-gamer")).toBeTruthy();
    expect(screen.getByTestId("roleplay-persona-senior_resident")).toBeTruthy();
  });

  it("briefs the rep before the knock, then opens with the customer's own line", () => {
    renderCoach({ initialPersonaId: "busy_homeowner" });
    expect(screen.getByTestId("roleplay-briefing").textContent).toContain("not saying no");
    fireEvent.click(screen.getByTestId("roleplay-start"));
    expect(screen.getByTestId("roleplay-conversation").textContent).toContain("something on the stove");
  });

  it("talks back when the rep types a turn, with no network and no microphone", async () => {
    renderCoach({ initialPersonaId: "busy_homeowner" });
    fireEvent.click(screen.getByTestId("roleplay-start"));
    const input = screen.getByTestId("roleplay-input");
    fireEvent.change(input, { target: { value: "Hi, my name is Sam, I'm with the Kinetic fiber crew on your street. Thirty seconds and I'm gone." } });
    fireEvent.click(screen.getByTestId("roleplay-send"));

    await waitFor(() => {
      const log = screen.getByRole("log");
      expect(log.textContent).toContain("Thirty seconds and I'm gone");
    });
    // The customer answered: there are now at least three turns.
    expect(screen.getByRole("log").children.length).toBeGreaterThanOrEqual(3);
    // No role-play network call happened during the conversation itself.
    expect(apiRequest.mock.calls.filter((c) => String(c[1]).includes("/roleplay"))).toHaveLength(0);
  });

  it("flags an unsupported number on the turn it was said", async () => {
    renderCoach({ initialPersonaId: "price_sensitive" });
    fireEvent.click(screen.getByTestId("roleplay-start"));
    fireEvent.change(screen.getByTestId("roleplay-input"), { target: { value: "I can get you in at $29 a month." } });
    fireEvent.click(screen.getByTestId("roleplay-send"));
    await waitFor(() => {
      expect(screen.getByRole("log").textContent).toContain("No live offer in this market is priced at that figure");
    });
  });

  it("hides the microphone control where the browser cannot listen", () => {
    renderCoach({ initialPersonaId: "gamer" });
    fireEvent.click(screen.getByTestId("roleplay-start"));
    // jsdom has no SpeechRecognition, so the drill is typed and says nothing
    // about a missing feature in the composer.
    expect(screen.queryByTestId("roleplay-mic")).toBeNull();
    expect(screen.getByTestId("roleplay-input")).toBeTruthy();
  });

  it("produces a full coaching report on ending, and never scores pressure as a positive", async () => {
    renderCoach({ initialPersonaId: "gamer" });
    fireEvent.click(screen.getByTestId("roleplay-start"));
    fireEvent.change(screen.getByTestId("roleplay-input"), { target: { value: "Come on, this is your last chance." } });
    fireEvent.click(screen.getByTestId("roleplay-send"));
    await act(async () => { fireEvent.click(screen.getByTestId("roleplay-finish")); });

    const report = await screen.findByTestId("score-report");
    expect(report).toBeTruthy();
    // Eleven dimensions, the flags block, and the promise about what is not scored.
    expect(screen.getAllByTestId(/^score-dimension-/)).toHaveLength(11);
    expect(screen.getByTestId("score-flags").textContent).toContain("pressure");
    expect(screen.getByTestId("score-unscored").textContent).toContain("aggression");
  });

  it("submits the finished session once, with the mode", async () => {
    apiRequest.mockImplementation((method: string, url: string) => {
      if (method === "POST" && url === "/api/training/academy/roleplay") {
        return jsonResponse({ sessionId: "x", score: null });
      }
      return jsonResponse({});
    });
    renderCoach({ initialPersonaId: "renter" });
    fireEvent.click(screen.getByTestId("roleplay-start"));
    fireEvent.change(screen.getByTestId("roleplay-input"), { target: { value: "Hi, my name is Sam, I'm with the Kinetic fiber crew on your street." } });
    fireEvent.click(screen.getByTestId("roleplay-send"));
    await act(async () => { fireEvent.click(screen.getByTestId("roleplay-finish")); });

    await waitFor(() => {
      const posts = apiRequest.mock.calls.filter((c) => c[0] === "POST" && String(c[1]).includes("/roleplay"));
      expect(posts).toHaveLength(1);
      expect(posts[0][2].mode).toBe("text");
      expect(posts[0][2].session.personaId).toBe("renter");
    });
  });

  it("still shows the report when the save fails, rather than losing the coaching", async () => {
    apiRequest.mockImplementation((method: string, url: string) => {
      if (method === "POST" && url === "/api/training/academy/roleplay") return Promise.reject(new Error("offline"));
      return jsonResponse({});
    });
    renderCoach({ initialPersonaId: "skeptic" });
    fireEvent.click(screen.getByTestId("roleplay-start"));
    fireEvent.change(screen.getByTestId("roleplay-input"), { target: { value: "Hi, my name is Sam, I'm with the Kinetic fiber crew here." } });
    fireEvent.click(screen.getByTestId("roleplay-send"));
    await act(async () => { fireEvent.click(screen.getByTestId("roleplay-finish")); });
    expect(await screen.findByTestId("score-report")).toBeTruthy();
  });

  it("keeps the transcript collapsed until asked for", async () => {
    renderCoach({ initialPersonaId: "renter" });
    fireEvent.click(screen.getByTestId("roleplay-start"));
    fireEvent.change(screen.getByTestId("roleplay-input"), { target: { value: "Hi, my name is Sam, I'm with the Kinetic fiber crew here." } });
    fireEvent.click(screen.getByTestId("roleplay-send"));
    await act(async () => { fireEvent.click(screen.getByTestId("roleplay-finish")); });

    await screen.findByTestId("score-report");
    expect(screen.queryByTestId("score-transcript")).toBeNull();
    fireEvent.click(screen.getByTestId("score-transcript-toggle"));
    expect(screen.getByTestId("score-transcript")).toBeTruthy();
  });
});

// ── The moment after an activity ──────────────────────────────────────────────
//
// The screen a new rep sees more often than any other. It has to acknowledge
// what happened WITHOUT congratulating a failed attempt, and it has to put the
// next thing one tap away, which is the only reason anybody does a second one.
describe("activity complete", () => {
  const firstStage = PATH_STAGES[0];
  const first = firstStage.activities[0];
  const scored = PATH_STAGES.flatMap((s) => s.activities).find((a) => a.passScore != null)!;

  function done(ids: { id: string; score?: number }[]): ActivityRecord[] {
    return ids.map(({ id, score }) => ({
      activityId: id, completedAt: "2026-08-27T12:00:00.000Z", score: score ?? null,
    }));
  }

  function renderComplete(records: ActivityRecord[], target: { activity: any; score?: number; earnedBefore: string[] }, handlers: any = {}) {
    return render(
      <ActivityComplete
        target={target}
        progress={computePathProgress(records)}
        certifications={certificationStatuses(records)}
        onNext={handlers.onNext ?? (() => {})}
        onRetry={handlers.onRetry ?? (() => {})}
        onBackToPath={handlers.onBackToPath ?? (() => {})}
      />,
    );
  }

  it("acknowledges the activity and puts the next one a single tap away", () => {
    const onNext = vi.fn();
    renderComplete(done([{ id: first.id }]), { activity: first, earnedBefore: [] }, { onNext });

    expect(screen.getByTestId("activity-complete-title").textContent).toBe(first.title);
    expect(screen.getByTestId("activity-complete-line").textContent).toContain("behind you");
    expect(screen.getByTestId("activity-complete-stage-count").textContent).toContain(`1 of ${firstStage.activities.length}`);

    fireEvent.click(screen.getByTestId("activity-complete-next-start"));
    expect(onNext).toHaveBeenCalledTimes(1);
    // The next activity offered is the path's own resume target, never a guess.
    expect(onNext.mock.calls[0][0].id).toBe(firstStage.activities[1].id);
  });

  it("does not congratulate a score under the bar, and offers the same drill again", () => {
    const onRetry = vi.fn();
    const under = Math.max(0, (scored.passScore ?? 60) - 20);
    renderComplete(done([{ id: scored.id, score: under }]), { activity: scored, score: under, earnedBefore: [] }, { onRetry });

    expect(screen.getByTestId("activity-complete-head").textContent).toContain("Attempt logged");
    expect(screen.getByTestId("activity-complete-line").textContent).toContain(`the bar is ${scored.passScore}`);
    expect(screen.queryByTestId("activity-complete-next-start")).toBeNull();

    fireEvent.click(screen.getByTestId("activity-complete-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("marks the stage complete only once every activity in it has passed", () => {
    const partial = done(firstStage.activities.slice(0, -1).map((a) => ({ id: a.id, score: a.passScore ?? undefined })));
    const { unmount } = renderComplete(partial, { activity: firstStage.activities[0], earnedBefore: [] });
    expect(screen.queryByTestId("stage-complete-banner")).toBeNull();
    unmount();

    const all = done(firstStage.activities.map((a) => ({ id: a.id, score: a.passScore ?? undefined })));
    renderComplete(all, { activity: firstStage.activities[firstStage.activities.length - 1], earnedBefore: [] });
    expect(screen.getByTestId("stage-complete-banner")).toBeTruthy();
  });

  // The certification banner is the biggest moment in the tab, so it may only
  // appear for a certification this activity actually produced.
  it("announces only a certification the rep did not already hold", () => {
    const doorReady = PATH_STAGES.filter((s) => ["stage-product", "stage-intro", "stage-field"].includes(s.id));
    const records = done(doorReady.flatMap((s) => s.activities).map((a) => ({ id: a.id, score: a.passScore ?? undefined })));
    const last = doorReady[doorReady.length - 1].activities[0];

    const { unmount } = renderComplete(records, { activity: last, earnedBefore: [] });
    expect(screen.getByTestId("certification-earned-cert-door-ready")).toBeTruthy();
    unmount();

    renderComplete(records, { activity: last, earnedBefore: ["cert-door-ready"] });
    expect(screen.queryByTestId("certification-earned-cert-door-ready")).toBeNull();
  });

  it("has a way back to the path from every state", () => {
    const onBackToPath = vi.fn();
    renderComplete(done([{ id: first.id }]), { activity: first, earnedBefore: [] }, { onBackToPath });
    fireEvent.click(screen.getByTestId("activity-complete-back"));
    expect(onBackToPath).toHaveBeenCalledTimes(1);
    expect(getActivity(first.id)).toBeTruthy();
  });
});
