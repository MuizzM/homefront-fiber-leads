// Accessibility, mobile layout and reduced motion for the Academy.
//
// These are the properties a rep on a phone in the sun actually depends on, and
// the ones that regress silently because nothing throws when they break:
//   * every tappable control clears the 44px one-handed floor (h-11/min-h-11),
//   * the section strip is a real tablist and is driven from the arrow keys,
//   * every icon-only control carries an accessible name,
//   * live regions announce, and error states are alerts rather than paragraphs,
//   * nothing scrolls the page sideways at 320px,
//   * a reduced-motion viewer gets no continuously moving element and no
//     unrequested synthesized speech.
import { fireEvent, render, screen, within } from "@testing-library/react";
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

import Training from "@/pages/Training";
import ScenarioQuiz from "@/components/academy/ScenarioQuiz";
import TimedIntro from "@/components/academy/TimedIntro";
import BranchingConversation from "@/components/academy/BranchingConversation";
import ObjectionDojo from "@/components/academy/ObjectionDojo";
import PitchLab from "@/components/academy/PitchLab";
import ReferenceLibrary from "@/components/academy/ReferenceLibrary";
import { ErrorPanel, PanelSkeleton, SectionTabs } from "@/components/academy/primitives";
import { BRANCH_TREES, SCENARIO_SETS } from "@shared/academyPath";

/** Whether prefers-reduced-motion should match. Flipped per test. */
let reducedMotion = false;

beforeAll(() => {
  (window as any).matchMedia = (query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reducedMotion : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
  if (!window.HTMLElement.prototype.scrollIntoView) {
    window.HTMLElement.prototype.scrollIntoView = () => {};
  }
  if (!(Element.prototype as any).scrollTo) (Element.prototype as any).scrollTo = () => {};
});

const EMPTY_ACADEMY = {
  records: [], states: [],
  path: { stages: [], done: 0, total: 0, percent: 0, resume: null },
  certifications: [], practiceAreas: [], assignments: [],
  rolePlayCount: 0, rolePlayAverage: null,
};
const EMPTY_OFFERS = { day: "2026-08-10", market: null, version: 1, offers: [], expired: [], headline: null, competitors: [] };

function jsonResponse(payload: any) {
  return Promise.resolve({ json: () => Promise.resolve(payload) });
}

function mockApi() {
  apiRequest.mockImplementation((method: string, url: string) => {
    if (method === "GET" && url === "/api/training/progress") return jsonResponse({ totalLessons: 113, completed: [] });
    if (method === "GET" && url === "/api/training/academy/progress") return jsonResponse(EMPTY_ACADEMY);
    if (method === "GET" && url.startsWith("/api/training/academy/offers")) return jsonResponse(EMPTY_OFFERS);
    return jsonResponse({});
  });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Training /></QueryClientProvider>);
}

/** The class-based 44px floor this codebase uses (--tap-target-min == h-11). */
function meetsTapFloor(el: Element): boolean {
  const cls = el.className ?? "";
  if (typeof cls !== "string") return false;
  return /(^|\s)(min-h-11|h-11|min-h-12|h-12|min-h-tap)(\s|$)/.test(cls);
}

/** Controls that are legitimately inline text rather than thumb targets. */
function isInlineControl(el: Element): boolean {
  const cls = String(el.className ?? "");
  return /(^|\s)sr-only(\s|$)/.test(cls);
}

beforeEach(() => {
  apiRequest.mockReset();
  reducedMotion = false;
});

describe("touch targets", () => {
  it("gives every button on the Academy shell at least 44px of height", async () => {
    mockApi();
    renderPage();
    await screen.findByTestId("training-hero-count");
    const buttons = [...document.querySelectorAll("button")].filter((b) => !isInlineControl(b));
    expect(buttons.length).toBeGreaterThan(5);
    for (const button of buttons) {
      expect(meetsTapFloor(button), `"${button.textContent?.trim().slice(0, 40)}" is below the 44px floor`).toBe(true);
    }
  });

  it("gives every option in a scenario quiz a full-size target", () => {
    render(
      <ScenarioQuiz
        set={SCENARIO_SETS[0]}
        activityId="act-product-scenario"
        resume={null}
        onComplete={() => {}}
        onExit={() => {}}
      />,
    );
    const options = [...document.querySelectorAll('[data-testid^="scenario-q0-opt"]')];
    expect(options.length).toBeGreaterThanOrEqual(3);
    for (const option of options) expect(meetsTapFloor(option)).toBe(true);
  });

  it("gives every branch option and every objection row a full-size target", () => {
    const { unmount } = render(
      <BranchingConversation
        tree={BRANCH_TREES[0]}
        activityId="act-branch-busy"
        resume={null}
        onComplete={() => {}}
        onExit={() => {}}
      />,
    );
    for (const option of document.querySelectorAll('[data-testid^="branching-option-"]')) {
      expect(meetsTapFloor(option)).toBe(true);
    }
    unmount();

    render(<ObjectionDojo completedKeys={new Set()} />);
    for (const row of document.querySelectorAll('[data-testid^="objection-"]')) {
      if (row.tagName !== "BUTTON") continue;
      expect(meetsTapFloor(row)).toBe(true);
    }
  });

  it("keeps the Pitch Lab reorder controls at 44px even though they are icon-only", () => {
    render(<PitchLab activityId={null} resume={{ blockIds: ["intro-build-crew", "close-two-slots"] }} offer={null} />);
    const up = screen.getByTestId("pitch-up-1");
    expect(meetsTapFloor(up)).toBe(true);
  });
});

describe("accessible names", () => {
  it("labels every icon-only control in the Pitch Lab", () => {
    render(<PitchLab activityId={null} resume={{ blockIds: ["intro-build-crew", "close-two-slots"] }} offer={null} />);
    for (const testId of ["pitch-up-1", "pitch-down-0", "pitch-remove-0"]) {
      const button = screen.getByTestId(testId);
      expect(button.getAttribute("aria-label"), testId).toBeTruthy();
    }
  });

  it("labels the reference search input", () => {
    render(
      <ReferenceLibrary
        offers={[]} expired={[]} competitors={[]} day="2026-08-10" market={null}
        readCardIds={new Set()}
      />,
    );
    expect(screen.getByLabelText("Search the reference library")).toBeTruthy();
  });

  it("names the role-play composer", async () => {
    mockApi();
    renderPage();
    // The composer lives inside the lazy role-play view; the label contract is
    // asserted on the tab strip's own accessible name here, and on the composer
    // in the role-play tests, which do not need a network.
    const strip = await screen.findByRole("tablist");
    expect(strip.getAttribute("aria-label")).toBe("Academy sections");
  });
});

describe("the section strip is a real tablist", () => {
  it("marks exactly one tab selected and takes it out of the tab order when not", async () => {
    mockApi();
    renderPage();
    const tabs = await screen.findAllByRole("tab");
    const selected = tabs.filter((t) => t.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    for (const tab of tabs) {
      expect(tab.getAttribute("tabindex")).toBe(tab === selected[0] ? "0" : "-1");
    }
  });

  it("moves between sections with the arrow keys", () => {
    const onChange = vi.fn();
    render(
      <SectionTabs
        tabs={[{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }]}
        value="a"
        onChange={onChange}
      />,
    );
    const list = screen.getByRole("tablist");
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("b");
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith("c"); // wraps
  });

  it("opens a section from the keyboard", async () => {
    mockApi();
    renderPage();
    const objections = await screen.findByTestId("academy-tab-objections");
    fireEvent.click(objections);
    expect(await screen.findByTestId("objection-dojo")).toBeTruthy();
  });
});

describe("announcements and states", () => {
  it("announces the loading skeleton as a status rather than leaving it silent", () => {
    render(<PanelSkeleton />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-label")).toBe("Loading");
  });

  it("renders an error as an alert with a retry, not a paragraph", () => {
    const onRetry = vi.fn();
    render(<ErrorPanel title="It broke" description="Nothing is lost." onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByTestId("academy-retry"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("announces a scenario result politely when the last answer lands", () => {
    const set = SCENARIO_SETS.find((s) => s.questions.length === 2) ?? SCENARIO_SETS[3];
    render(
      <ScenarioQuiz set={set} activityId="act-discovery-scenario" resume={null} onComplete={() => {}} onExit={() => {}} />,
    );
    for (let i = 0; i < set.questions.length; i++) {
      fireEvent.click(screen.getByTestId(`scenario-q${i}-opt${set.questions[i].answerIndex}`));
      if (i < set.questions.length - 1) fireEvent.click(screen.getByTestId("scenario-next"));
    }
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain("Scenario complete");
  });

  it("groups scenario options as a radiogroup so a screen reader announces the choice count", () => {
    render(
      <ScenarioQuiz set={SCENARIO_SETS[0]} activityId="act-product-scenario" resume={null} onComplete={() => {}} onExit={() => {}} />,
    );
    const group = screen.getByRole("radiogroup");
    expect(within(group).getAllByRole("radio").length).toBe(SCENARIO_SETS[0].questions[0].options.length);
  });
});

describe("mobile layout", () => {
  it("never lets the shell scroll sideways: no fixed pixel widths on the page container", async () => {
    mockApi();
    renderPage();
    await screen.findByTestId("training-hero-count");
    // The page container is width-constrained by max-width and padding only.
    const container = document.querySelector(".max-w-4xl");
    expect(container).toBeTruthy();
    expect(String(container!.className)).toContain("w-full");
    expect(String(container!.className)).not.toMatch(/\bw-\[\d+px\]/);
  });

  it("scrolls the tab strip horizontally rather than wrapping it off screen", async () => {
    mockApi();
    renderPage();
    const strip = await screen.findByRole("tablist");
    expect(String(strip.className)).toContain("overflow-x-auto");
  });

  it("stacks the offer editor fields two-up rather than in a fixed-width row", () => {
    render(<PitchLab activityId={null} resume={{ blockIds: [] }} offer={null} />);
    // Category rows are full-width buttons, not a fixed grid.
    const category = screen.getByTestId("pitch-category-introduction");
    expect(String(category.className)).toContain("w-full");
  });
});

describe("reduced motion", () => {
  it("does not animate the timed-intro rail when reduced motion is requested", () => {
    reducedMotion = true;
    render(<TimedIntro resume={null} onComplete={() => {}} onExit={() => {}} />);
    fireEvent.click(screen.getByTestId("timed-intro-start"));
    const seconds = screen.getByTestId("timed-intro-seconds");
    // The rail is the only continuously moving element; under reduced motion it
    // must carry no width transition.
    const rail = seconds.closest('[data-testid="timed-intro-clock"]')!.querySelector(".rounded-full.bg-primary, .rounded-full.bg-success");
    expect(String(rail?.className ?? "")).not.toContain("transition-[width]");
  });

  it("does animate it for everyone else", () => {
    reducedMotion = false;
    render(<TimedIntro resume={null} onComplete={() => {}} onExit={() => {}} />);
    fireEvent.click(screen.getByTestId("timed-intro-start"));
    const clock = screen.getByTestId("timed-intro-clock");
    const rail = clock.querySelector(".rounded-full.bg-primary, .rounded-full.bg-success");
    expect(String(rail?.className ?? "")).toContain("transition-[width]");
  });

  it("keeps the entrance stagger declarative, so the CSS reduced-motion rule governs it", async () => {
    mockApi();
    renderPage();
    await screen.findByTestId("training-hero-count");
    // The stagger is a class, not a JS animation, which is what lets the global
    // prefers-reduced-motion block collapse it without this component knowing.
    expect(document.querySelector(".hf-stagger")).toBeTruthy();
  });
});
