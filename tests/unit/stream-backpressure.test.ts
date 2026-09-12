import { expect, it, vi } from "vitest";
import type { Response } from "express";
import { guardSessionStream, MAX_STREAM_BUFFER_BYTES } from "../../server/streamSessionGuard";

it.each(["queued", "large-frame"])("closes a %s stream before forwarding an over-budget frame", kind => {
  const write = vi.fn(), end = vi.fn(), destroy = vi.fn(), authority = vi.fn(() => true);
  const res = { write, end, destroy, getHeader: () => "text/event-stream", writableLength: kind === "queued" ? MAX_STREAM_BUFFER_BYTES : 0 } as unknown as Response;
  guardSessionStream(res, authority);
  expect(res.write(kind === "queued" ? "data: next\n\n" : "x".repeat(MAX_STREAM_BUFFER_BYTES + 1))).toBe(false);
  expect(destroy).toHaveBeenCalledOnce();
  expect(write).not.toHaveBeenCalled(); expect(authority).not.toHaveBeenCalled();
  res.write("late"); expect(write).not.toHaveBeenCalled();
});
it("bounds end(payload) but allows bare cleanup and finite queued writes", () => {
  const write = vi.fn(() => false), end = vi.fn(), destroy = vi.fn();
  const res = { write, end, destroy, getHeader: () => "text/event-stream", writableLength: 100 } as unknown as Response;
  guardSessionStream(res, () => true);
  expect(res.write("data: permitted\n\n")).toBe(false); expect(write).toHaveBeenCalledOnce();
  res.end("x".repeat(MAX_STREAM_BUFFER_BYTES)); expect(destroy).toHaveBeenCalledOnce(); expect(end).not.toHaveBeenCalled();
  res.end(); expect(end).toHaveBeenCalledOnce();
});
it.each([false, "throw"])("fails closed when authority is %s, including later payloads", authority => {
  const write = vi.fn(), end = vi.fn(), destroy = vi.fn();
  const res = { write, end, destroy, getHeader: () => "text/event-stream", writableLength: 0 } as unknown as Response;
  guardSessionStream(res, () => { if (authority === "throw") throw new Error("unreadable authority"); return false; });
  expect(res.write("data: forbidden\n\n")).toBe(false);
  expect(end).toHaveBeenCalledOnce(); expect(write).not.toHaveBeenCalled();
  res.write("data: later\n\n"); expect(write).not.toHaveBeenCalled();
});
