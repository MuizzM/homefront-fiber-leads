// Training page — the Academy shell plus the curriculum Library it wraps.
//
// The contract this file pins:
//   * the module Library still renders every module and every lesson, and the
//     lesson reader, quiz and optimistic completion behave exactly as before
//     the redesign (the training_progress write is unchanged, and the training
//     gate depends on it),
//   * the hero reports PATH progress and shows a dash rather than a zero when
//     progress could not be loaded,
//   * reps never see the team section and never fetch team data.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TRAINING_MODULES,
  TOTAL_TRAINING_LESSONS,
} from "../../shared/trainingContent";

const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: undefined,
}));

let mockRole = "rep";
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: 1, name: "Test Rep", role: mockRole } }),
}));

import Training from "../../client/src/pages/Training";

const firstLesson = TRAINING_MODULES[0].lessons[0];

function jsonResponse(payload: any) {
  return Promise.resolve({ json: () => Promise.resolve(payload) });
}

export const EMPTY_ACADEMY = {
  records: [],
  states: [],
  path: { stages: [], done: 0, total: 0, percent: 0, resume: null },
  certifications: [],
  practiceAreas: [],
  assignments: [],
  rolePlayCount: 0,
  rolePlayAverage: null,
};

const EMPTY_OFFERS = {
  day: "2026-08-10", market: null, version: 1,
  offers: [], expired: [], headline: null, competitors: [],
};

function mockApi({
  completed = [] as any[],
  academy = EMPTY_ACADEMY as any,
  offers = EMPTY_OFFERS as any,
  postBehavior = "resolve" as "resolve" | "hang",
} = {}) {
  apiRequest.mockImplementation((method: string, url: string, body?: any) => {
    if (method === "GET" && url === "/api/training/progress") {
      return jsonResponse({ totalLessons: TOTAL_TRAINING_LESSONS, completed });
    }
    if (method === "GET" && url === "/api/training/academy/progress") {
      return jsonResponse(academy);
    }
    if (method === "GET" && url.startsWith("/api/training/academy/offers")) {
      return jsonResponse(offers);
    }
    if (method === "POST" && url.startsWith("/api/training/lessons/")) {
      if (postBehavior === "hang") return new Promise(() => {});
      const lessonId = url.split("/")[4];
      return jsonResponse({ lessonId, completedAt: new Date().toISOString(), quizScore: body?.quizScore ?? null });
    }
    return jsonResponse({});
  });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Training /></QueryClientProvider>);
}

/** The curriculum moved behind a tab; open it. */
async function openLibrary() {
  fireEvent.click(await screen.findByTestId("academy-tab-library"));
  await screen.findByTestId("academy-library");
}

beforeEach(() => {
  apiRequest.mockReset();
  mockRole = "rep";
});

describe("Training library", () => {
  it("renders every module with its lessons", async () => {
    mockApi();
    renderPage();
    await openLibrary();
    for (const mod of TRAINING_MODULES) {
      expect(screen.getByTestId(`training-module-${mod.id}`)).toBeTruthy();
    }
    expect(screen.getByTestId(`training-lesson-${firstLesson.id}`)).toBeTruthy();
  });

  it("marks a lesson complete optimistically - the count moves before the server answers", async () => {
    mockApi({ postBehavior: "hang" });
    renderPage();
    await openLibrary();

    fireEvent.click(screen.getByTestId(`training-lesson-${firstLesson.id}`));
    await screen.findByTestId(`lesson-view-${firstLesson.id}`);

    fireEvent.click(screen.getByTestId("lesson-mark-complete"));
    fireEvent.click(screen.getByTestId("lesson-back"));

    // The POST never resolved, yet the cache already counts the lesson.
    await waitFor(() => {
      expect(screen.getByTestId("training-lessons-done").textContent).toContain("1");
    });
  });

  it("scores the quiz with instant feedback and locks each question after one pick", async () => {
    mockApi();
    renderPage();
    await openLibrary();
    fireEvent.click(screen.getByTestId(`training-lesson-${firstLesson.id}`));
    await screen.findByTestId("lesson-quiz");

    // Answer question 0 correctly.
    fireEvent.click(screen.getByTestId(`quiz-q0-opt${firstLesson.quiz[0].answerIndex}`));
    expect((await screen.findByTestId("quiz-q0-feedback")).textContent).toContain("Correct");

    // Answer question 1 wrong.
    const wrong = firstLesson.quiz[1].answerIndex === 0 ? 1 : 0;
    fireEvent.click(screen.getByTestId(`quiz-q1-opt${wrong}`));
    expect((await screen.findByTestId("quiz-q1-feedback")).textContent).toContain("Not quite");

    for (let qi = 2; qi < firstLesson.quiz.length; qi++) {
      fireEvent.click(screen.getByTestId(`quiz-q${qi}-opt${firstLesson.quiz[qi].answerIndex}`));
    }
    const answered = firstLesson.quiz.length - 1; // all but q1 correct
    const expected = Math.round((answered / firstLesson.quiz.length) * 100);
    expect(screen.getByTestId("quiz-progress").textContent).toContain(`Score: ${expected}%`);

    // Completing sends the quiz score to the UNCHANGED lesson endpoint.
    fireEvent.click(screen.getByTestId("lesson-mark-complete"));
    await waitFor(() => {
      const post = apiRequest.mock.calls.find((c) => c[0] === "POST" && String(c[1]).includes("/lessons/"));
      expect(post).toBeTruthy();
      expect(post![1]).toBe(`/api/training/lessons/${firstLesson.id}/complete`);
      expect(post![2]).toEqual({ quizScore: expected });
    });
  });

  it("shows completed lessons from the server with their saved score", async () => {
    mockApi({ completed: [{ lessonId: firstLesson.id, completedAt: "2026-08-01T00:00:00Z", quizScore: 67 }] });
    renderPage();
    await openLibrary();
    expect(screen.getByTestId(`training-lesson-${firstLesson.id}`).textContent).toContain("67%");
  });

  it("renders every arsenal module (m10-m15): first lesson shows its title and section bodies", async () => {
    mockApi();
    renderPage();
    await openLibrary();
    const arsenal = TRAINING_MODULES.filter((m) => ["m10", "m11", "m12", "m13", "m14", "m15"].includes(m.id));
    expect(arsenal).toHaveLength(6);
    for (const mod of arsenal) {
      expect(screen.getByTestId(`training-module-${mod.id}`)).toBeTruthy();
      const lesson = mod.lessons[0];
      fireEvent.click(screen.getByTestId(`training-lesson-${lesson.id}`));
      await screen.findByTestId(`lesson-view-${lesson.id}`);
      expect(screen.getByRole("heading", { name: lesson.title })).toBeTruthy();
      expect(screen.getByText(lesson.sections[0].body[0])).toBeTruthy();
      fireEvent.click(screen.getByTestId("lesson-back"));
      await screen.findByTestId(`training-module-${mod.id}`);
    }
  });

  it("renders every expansion module (m16-m22): first lesson shows its title and section bodies", async () => {
    mockApi();
    renderPage();
    await openLibrary();
    const expansion = TRAINING_MODULES.filter((m) => ["m16", "m17", "m18", "m19", "m20", "m21", "m22"].includes(m.id));
    expect(expansion).toHaveLength(7);
    for (const mod of expansion) {
      expect(screen.getByTestId(`training-module-${mod.id}`)).toBeTruthy();
      const lesson = mod.lessons[0];
      fireEvent.click(screen.getByTestId(`training-lesson-${lesson.id}`));
      await screen.findByTestId(`lesson-view-${lesson.id}`);
      expect(screen.getByRole("heading", { name: lesson.title })).toBeTruthy();
      expect(screen.getByText(lesson.sections[0].body[0])).toBeTruthy();
      fireEvent.click(screen.getByTestId("lesson-back"));
      await screen.findByTestId(`training-module-${mod.id}`);
    }
  });
});

describe("Training hero", () => {
  it("reports path progress, not a zero, while it is still loading or errored", async () => {
    apiRequest.mockImplementation((method: string, url: string) => {
      if (method === "GET" && url === "/api/training/progress") {
        return jsonResponse({ totalLessons: TOTAL_TRAINING_LESSONS, completed: [] });
      }
      if (method === "GET" && url === "/api/training/academy/progress") {
        return Promise.reject(new Error("offline"));
      }
      return jsonResponse(EMPTY_OFFERS);
    });
    renderPage();
    // A dash, never "0 of 40" - telling a finished rep their progress reset is
    // the bug this assertion exists to prevent.
    await waitFor(() => {
      expect(screen.getByTestId("training-hero-count").textContent).toContain("-");
    });
    expect(screen.getByTestId("training-hero-count").textContent).not.toContain("0 of");
  });

  it("shows path completion once the academy payload lands", async () => {
    mockApi({
      academy: {
        ...EMPTY_ACADEMY,
        path: { stages: [], done: 7, total: 20, percent: 35, resume: null },
      },
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("training-hero-count").textContent).toContain("7 of 20");
    });
  });
});

describe("Training team section", () => {
  it("hides the team tab from reps and never fetches team data", async () => {
    mockApi();
    renderPage();
    await screen.findByTestId("training-hero-count");
    expect(screen.queryByTestId("academy-tab-team")).toBeNull();
    expect(apiRequest.mock.calls.some((c) => String(c[1]).includes("/academy/team"))).toBe(false);
  });

  it("offers the team tab to a manager", async () => {
    mockRole = "manager";
    mockApi();
    renderPage();
    expect(await screen.findByTestId("academy-tab-team")).toBeTruthy();
  });

  it("offers the team tab to a team lead", async () => {
    mockRole = "team_lead";
    mockApi();
    renderPage();
    expect(await screen.findByTestId("academy-tab-team")).toBeTruthy();
  });
});
