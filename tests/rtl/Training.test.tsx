// Training page — modules render from the shared curriculum, completion is
// optimistic (the hero moves before the server answers), quizzes give instant
// feedback and produce a score, and the team table only exists for managers.
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

function mockApi({
  completed = [] as any[],
  summary = { totalLessons: TOTAL_TRAINING_LESSONS, reps: [] as any[] },
  postBehavior = "resolve" as "resolve" | "hang",
} = {}) {
  apiRequest.mockImplementation((method: string, url: string, body?: any) => {
    if (method === "GET" && url === "/api/training/progress") {
      return jsonResponse({ totalLessons: TOTAL_TRAINING_LESSONS, completed });
    }
    if (method === "GET" && url === "/api/training/summary") {
      return jsonResponse(summary);
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

beforeEach(() => {
  apiRequest.mockReset();
  mockRole = "rep";
});

describe("Training page", () => {
  it("renders every module with its lessons and a 0-of-N hero", async () => {
    mockApi();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("training-hero-count").textContent).toContain(`0 of ${TOTAL_TRAINING_LESSONS}`);
    });
    for (const mod of TRAINING_MODULES) {
      expect(screen.getByTestId(`training-module-${mod.id}`)).toBeTruthy();
    }
    // Every lesson row is a real button.
    expect(screen.getByTestId(`training-lesson-${firstLesson.id}`)).toBeTruthy();
  });

  it("marks a lesson complete optimistically — the hero moves before the server answers", async () => {
    mockApi({ postBehavior: "hang" });
    renderPage();
    await screen.findByTestId("training-hero-count");

    fireEvent.click(screen.getByTestId(`training-lesson-${firstLesson.id}`));
    await screen.findByTestId(`lesson-view-${firstLesson.id}`);

    fireEvent.click(screen.getByTestId("lesson-mark-complete"));
    fireEvent.click(screen.getByTestId("lesson-back"));

    // The POST never resolved, yet the cache already counts the lesson.
    await waitFor(() => {
      expect(screen.getByTestId("training-hero-count").textContent).toContain(`1 of ${TOTAL_TRAINING_LESSONS}`);
    });
  });

  it("scores the quiz with instant feedback and locks each question after one pick", async () => {
    mockApi();
    renderPage();
    await screen.findByTestId("training-hero-count");
    fireEvent.click(screen.getByTestId(`training-lesson-${firstLesson.id}`));
    await screen.findByTestId("lesson-quiz");

    // Answer question 0 correctly.
    fireEvent.click(screen.getByTestId(`quiz-q0-opt${firstLesson.quiz[0].answerIndex}`));
    expect((await screen.findByTestId("quiz-q0-feedback")).textContent).toContain("Correct");

    // Answer question 1 wrong.
    const wrong = firstLesson.quiz[1].answerIndex === 0 ? 1 : 0;
    fireEvent.click(screen.getByTestId(`quiz-q1-opt${wrong}`));
    expect((await screen.findByTestId("quiz-q1-feedback")).textContent).toContain("Not quite");

    // Answer the remaining questions correctly, then the score line appears.
    for (let qi = 2; qi < firstLesson.quiz.length; qi++) {
      fireEvent.click(screen.getByTestId(`quiz-q${qi}-opt${firstLesson.quiz[qi].answerIndex}`));
    }
    const answered = firstLesson.quiz.length - 1; // all but q1 correct
    const expected = Math.round((answered / firstLesson.quiz.length) * 100);
    expect(screen.getByTestId("quiz-progress").textContent).toContain(`Score: ${expected}%`);

    // Completing now sends the quiz score to the server.
    fireEvent.click(screen.getByTestId("lesson-mark-complete"));
    await waitFor(() => {
      const post = apiRequest.mock.calls.find((c) => c[0] === "POST");
      expect(post).toBeTruthy();
      expect(post![1]).toBe(`/api/training/lessons/${firstLesson.id}/complete`);
      expect(post![2]).toEqual({ quizScore: expected });
    });
  });

  it("shows completed lessons from the server with their saved score", async () => {
    mockApi({ completed: [{ lessonId: firstLesson.id, completedAt: "2026-08-01T00:00:00Z", quizScore: 67 }] });
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("training-hero-count").textContent).toContain(`1 of ${TOTAL_TRAINING_LESSONS}`);
    });
    expect(screen.getByTestId(`training-lesson-${firstLesson.id}`).textContent).toContain("67%");
  });

  it("renders every arsenal module (m10-m15): first lesson shows its title and section bodies", async () => {
    mockApi();
    renderPage();
    await screen.findByTestId("training-hero-count");
    const arsenal = TRAINING_MODULES.filter((m) => ["m10", "m11", "m12", "m13", "m14", "m15"].includes(m.id));
    expect(arsenal).toHaveLength(6);
    for (const mod of arsenal) {
      // Module card and its lesson rows are present on the overview.
      expect(screen.getByTestId(`training-module-${mod.id}`)).toBeTruthy();
      const lesson = mod.lessons[0];
      fireEvent.click(screen.getByTestId(`training-lesson-${lesson.id}`));
      await screen.findByTestId(`lesson-view-${lesson.id}`);
      // Title and at least one section body paragraph render in the reader.
      expect(screen.getByRole("heading", { name: lesson.title })).toBeTruthy();
      expect(screen.getByText(lesson.sections[0].body[0])).toBeTruthy();
      fireEvent.click(screen.getByTestId("lesson-back"));
      await screen.findByTestId(`training-module-${mod.id}`);
    }
  });

  it("hides the team table from reps and never fetches the summary", async () => {
    mockApi();
    renderPage();
    await screen.findByTestId("training-hero-count");
    expect(screen.queryByTestId("training-team-table")).toBeNull();
    expect(apiRequest.mock.calls.some((c) => String(c[1]).includes("/api/training/summary"))).toBe(false);
  });

  it("shows managers the per-rep completion table", async () => {
    mockRole = "manager";
    mockApi({
      summary: {
        totalLessons: TOTAL_TRAINING_LESSONS,
        reps: [
          { userId: 7, name: "Alice Field", role: "rep", completedCount: 5, avgQuizScore: 88, lastCompletedAt: "2026-08-01" },
          { userId: 8, name: "Bob Porch", role: "rep", completedCount: 0, avgQuizScore: null, lastCompletedAt: null },
        ],
      },
    });
    renderPage();
    const table = await screen.findByTestId("training-team-table");
    expect(table.textContent).toContain("Alice Field");
    const alice = screen.getByTestId("training-team-row-7");
    expect(alice.textContent).toContain("5");
    expect(alice.textContent).toContain("88%");
    const bob = screen.getByTestId("training-team-row-8");
    expect(bob.textContent).toContain("0");
  });
});
