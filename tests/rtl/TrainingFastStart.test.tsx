// The fast-start track and the standalone pitch-practice entry on /training.
// Same RTL harness as Training.test.tsx: mock the query/auth boundaries, render
// the page, assert on testids. Focus here is the new-rep scaffolding — the
// "get door-ready in 15 minutes" list up top and the Pitch practice header entry.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TOTAL_TRAINING_LESSONS,
  TRAINING_FAST_START,
  getFastStartLessons,
} from "../../shared/trainingContent";

const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: undefined,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: 1, name: "Test Rep", role: "rep" } }),
}));

import Training from "../../client/src/pages/Training";

function jsonResponse(payload: any) {
  return Promise.resolve({ json: () => Promise.resolve(payload) });
}

function mockApi({ completed = [] as any[] } = {}) {
  apiRequest.mockImplementation((method: string, url: string) => {
    if (method === "GET" && url === "/api/training/progress") {
      return jsonResponse({ totalLessons: TOTAL_TRAINING_LESSONS, completed });
    }
    if (method === "GET" && url === "/api/training/summary") {
      return jsonResponse({ totalLessons: TOTAL_TRAINING_LESSONS, reps: [] });
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Training fast-start track", () => {
  it("renders for a low-completion rep and lists the real fast-start lessons in order", async () => {
    mockApi({ completed: [] });
    renderPage();

    const track = await screen.findByTestId("fast-start-track");
    expect(track.textContent).toContain("Get door-ready in 15 minutes");

    // Every step is present, references a real lesson, and shows its title.
    const resolved = getFastStartLessons();
    expect(resolved.length).toBe(TRAINING_FAST_START.length);
    for (const { lesson } of resolved) {
      const step = screen.getByTestId(`fast-start-step-${lesson.id}`);
      expect(step.textContent).toContain(lesson.title);
    }
  });

  it("opens the referenced lesson when a fast-start step is clicked", async () => {
    mockApi({ completed: [] });
    renderPage();
    await screen.findByTestId("fast-start-track");

    const first = getFastStartLessons()[0].lesson;
    fireEvent.click(screen.getByTestId(`fast-start-step-${first.id}`));
    expect(await screen.findByTestId(`lesson-view-${first.id}`)).toBeTruthy();
  });

  it("hides once the rep has completed the fast-start lessons", async () => {
    const completed = TRAINING_FAST_START.map((s) => ({
      lessonId: s.lessonId,
      completedAt: "2026-08-01T00:00:00Z",
      quizScore: 100,
    }));
    mockApi({ completed });
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("training-hero-count").textContent).toContain(
        `${TRAINING_FAST_START.length} of ${TOTAL_TRAINING_LESSONS}`,
      );
    });
    expect(screen.queryByTestId("fast-start-track")).toBeNull();
  });
});

describe("Training pitch-practice entry", () => {
  it("hides the Pitch practice header button when MediaRecorder is unavailable", async () => {
    mockApi();
    renderPage();
    await screen.findByTestId("training-hero-count");
    // jsdom has no MediaRecorder, so the recorder feature is hidden.
    expect(screen.queryByTestId("open-pitch-practice")).toBeNull();
  });

  it("opens the standalone pitch-practice view when supported", async () => {
    // Install the native pieces the recorder needs.
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn() },
    });
    (globalThis as any).MediaRecorder = class {} as any;
    try {
      mockApi();
      renderPage();
      const btn = await screen.findByTestId("open-pitch-practice");
      await act(async () => { fireEvent.click(btn); });
      expect(await screen.findByTestId("pitch-practice-view")).toBeTruthy();
      // The standalone view exposes at least one recorder panel.
      expect(screen.getAllByTestId("pitch-recorder").length).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(globalThis.navigator, "mediaDevices", { configurable: true, value: undefined });
      delete (globalThis as any).MediaRecorder;
    }
  });
});
