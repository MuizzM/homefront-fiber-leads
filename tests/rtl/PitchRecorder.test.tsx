// PitchRecorder — the practice mirror. These tests drive the native pieces the
// component depends on (getUserMedia + MediaRecorder) with light mocks, following
// the repo's RTL style: mock the module boundary, render, assert on testids.
//
// Coverage: the happy path (record -> stop -> playback element appears), the
// permission-denied path (clear message, no playback), the unsupported-browser
// path (feature hidden entirely), and unmount cleanup (tracks stopped, no hot mic).
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PitchRecorder from "../../client/src/components/training/PitchRecorder";

// ── Native mocks ──────────────────────────────────────────────────────────────
let stopCalls: number;
let getUserMedia: ReturnType<typeof vi.fn>;

function makeTrack() {
  return { stop: vi.fn(() => { stopCalls++; }), kind: "audio" };
}

// A minimal MediaRecorder stand-in: start() flips state, stop() emits one data
// chunk then fires onstop — the same order the real API uses.
class MockMediaRecorder {
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((e: any) => void) | null = null;
  onstop: (() => void) | null = null;
  stream: any;
  constructor(stream: any) { this.stream = stream; }
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
    this.onstop?.();
  }
}

function installSupport() {
  stopCalls = 0;
  const tracks = [makeTrack()];
  getUserMedia = vi.fn(async () => ({ getTracks: () => tracks }));
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  (globalThis as any).MediaRecorder = MockMediaRecorder as any;
  // jsdom lacks these — the component guards them, but provide no-ops so the
  // object-URL bookkeeping has something to call.
  if (!globalThis.URL.createObjectURL) {
    (globalThis.URL as any).createObjectURL = vi.fn(() => "blob:mock-take");
  } else {
    vi.spyOn(globalThis.URL, "createObjectURL").mockReturnValue("blob:mock-take");
  }
  if (!globalThis.URL.revokeObjectURL) {
    (globalThis.URL as any).revokeObjectURL = vi.fn();
  } else {
    vi.spyOn(globalThis.URL, "revokeObjectURL").mockImplementation(() => {});
  }
}

function removeSupport() {
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: undefined,
  });
  delete (globalThis as any).MediaRecorder;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PitchRecorder", () => {
  describe("when the browser supports recording", () => {
    beforeEach(() => installSupport());

    it("records, stops, and reveals a playback element", async () => {
      render(<PitchRecorder prompt="Read your 30-second pitch." />);
      expect(screen.getByTestId("pitch-recorder")).toBeTruthy();
      expect(screen.getByTestId("pitch-prompt").textContent).toContain("30-second pitch");

      // No playback before recording.
      expect(screen.queryByTestId("pitch-playback")).toBeNull();

      await act(async () => {
        fireEvent.click(screen.getByTestId("pitch-record"));
      });
      // getUserMedia was requested and we are now recording.
      expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
      expect(await screen.findByTestId("pitch-stop")).toBeTruthy();

      await act(async () => {
        fireEvent.click(screen.getByTestId("pitch-stop"));
      });

      // Playback element appears; re-record and keep controls are offered.
      const playback = await screen.findByTestId("pitch-playback");
      expect(playback).toBeTruthy();
      expect((playback as HTMLAudioElement).getAttribute("src")).toBe("blob:mock-take");
      expect(screen.getByTestId("pitch-rerecord")).toBeTruthy();
      expect(screen.getByTestId("pitch-keep")).toBeTruthy();

      // Stopping released the mic track.
      expect(stopCalls).toBeGreaterThan(0);
    });

    it("keeps a take and shows the kept confirmation", async () => {
      render(<PitchRecorder prompt="Read it." />);
      await act(async () => { fireEvent.click(screen.getByTestId("pitch-record")); });
      await screen.findByTestId("pitch-stop");
      await act(async () => { fireEvent.click(screen.getByTestId("pitch-stop")); });
      await screen.findByTestId("pitch-playback");

      await act(async () => { fireEvent.click(screen.getByTestId("pitch-keep")); });
      expect(await screen.findByTestId("pitch-kept")).toBeTruthy();
    });

    it("stops every media track on unmount so no mic is left hot", async () => {
      const { unmount } = render(<PitchRecorder prompt="Read it." />);
      await act(async () => { fireEvent.click(screen.getByTestId("pitch-record")); });
      await screen.findByTestId("pitch-stop");
      const before = stopCalls;
      unmount();
      expect(stopCalls).toBeGreaterThan(before);
    });
  });

  describe("permission denied", () => {
    beforeEach(() => {
      installSupport();
      getUserMedia.mockRejectedValue(Object.assign(new Error("no"), { name: "NotAllowedError" }));
    });

    it("shows a clear message and never reaches playback", async () => {
      render(<PitchRecorder prompt="Read it." />);
      await act(async () => { fireEvent.click(screen.getByTestId("pitch-record")); });

      const msg = await screen.findByTestId("pitch-permission-denied");
      expect(msg.textContent?.toLowerCase()).toContain("microphone");
      expect(screen.queryByTestId("pitch-playback")).toBeNull();
      // Recovers to a "try again" affordance.
      expect(screen.getByTestId("pitch-record").textContent).toContain("Try again");
    });
  });

  describe("when the browser does not support recording", () => {
    beforeEach(() => removeSupport());

    it("hides the feature entirely", () => {
      const { container } = render(<PitchRecorder prompt="Read it." />);
      expect(screen.queryByTestId("pitch-recorder")).toBeNull();
      expect(container.firstChild).toBeNull();
    });
  });
});
