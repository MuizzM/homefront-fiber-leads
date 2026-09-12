import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ReadableStream } from "node:stream/web";

const auth = vi.hoisted(() => ({ user: { isSuperAdmin: false }, sessionId: "fixture" }));
vi.mock("@/lib/auth", () => ({ useAuth: () => auth }));
vi.mock("@/hooks/use-foreground-activity", () => ({ useForegroundActivity: () => true }));
vi.mock("@/lib/tabActivity", () => ({ useTabActive: () => true }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/queryClient", () => ({ apiRequest: vi.fn() }));
import ScanInspector from "@/components/fiber/ScanInspector";
let close: () => void;
afterEach(() => { cleanup(); close?.(); vi.unstubAllGlobals(); });

it.each([false, true])("shows only authorized diagnostics and controls, platform=%s", async platform => {
  auth.user.isSuperAdmin = platform;
  const health = platform ? { paused: false, decodoConnected: true, tokenReady: true, tokenPool: { ready: 1, size: 1 } } : { paused: true };
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify({ rows: [], health })}\n\n`));
    close = () => controller.close();
  } });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, body })));
  render(<ScanInspector scopeLabel="Fixture city" />);
  expect(await screen.findByText("Live")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Copy diagnostics" })).toBeTruthy();
  if (platform) {
    expect(screen.getByText("Decodo connected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  } else {
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.queryByText(/Decodo|resolving|token none/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Pause|Resume|Stop|Retry failed/ })).toBeNull();
    expect(screen.queryByText(/All-market controls/)).toBeNull();
  }
});
