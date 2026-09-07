import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useForegroundActivity } from "../../client/src/hooks/use-foreground-activity";
afterEach(() => vi.restoreAllMocks());
it("pauses display work for hidden, offline, and inactive routes and resumes on return", () => {
  let visibility = "visible";
  vi.spyOn(document,"visibilityState","get").mockImplementation(()=>visibility as DocumentVisibilityState);
  vi.spyOn(navigator,"onLine","get").mockReturnValue(true);
  const hook = renderHook(({active})=>useForegroundActivity(active),{initialProps:{active:true}});
  expect(hook.result.current).toBe(true);
  act(()=>{ visibility="hidden"; document.dispatchEvent(new Event("visibilitychange")); }); expect(hook.result.current).toBe(false);
  act(()=>window.dispatchEvent(new Event("offline")));
  act(()=>{ visibility="visible"; document.dispatchEvent(new Event("visibilitychange")); }); expect(hook.result.current).toBe(false);
  act(()=>window.dispatchEvent(new Event("online"))); expect(hook.result.current).toBe(true);
  hook.rerender({active:false}); expect(hook.result.current).toBe(false);
  hook.rerender({active:true}); expect(hook.result.current).toBe(true);
  hook.unmount();
});
