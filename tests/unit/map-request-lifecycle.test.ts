// @vitest-environment node
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { fetchSessionJson, getRequestScopeSignal, setSessionId } from "../../client/src/lib/queryClient";
const { mapFixture, leadEventsFixture, settle, effects, compile } = createRequire(import.meta.url)("../helpers/map-callback-fixtures.cjs");
afterEach(() => { setSessionId(null); vi.unstubAllGlobals(); vi.useRealTimers(); });
function fixture() {
  setSessionId("synthetic-first-session");
  const f = mapFixture({ fetchSessionJson, getRequestScopeSignal });
  vi.stubGlobal("fetch", f.context.fetch);
  return f;
}
it.each(["pins", "grid"])("%s bounds stalled headers and bodies, then permits another refresh", async kind => {
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout","Date"]});
  for (const stalledBody of [false, true]) {
    const f = fixture(); f[kind]();
    if (stalledBody) f.requests[0].resolve({ok:true,status:200,json:()=>new Promise(()=>{})});
    await vi.advanceTimersByTimeAsync(30_001); await settle();
    expect(f.requests[0].options.signal.aborted).toBe(true);
    f[kind](); expect(f.requests).toHaveLength(2);
    setSessionId(null); await settle();
  }
});
it.each(["pins", "grid"])("%s rejects late responses on identity change and unmount", async kind => {
  for (const retirement of ["session", "unmount"]) {
    const f = fixture(); const cleanup = f.installLoaderCleanup(); f[kind]();
    if(retirement === "session") setSessionId("synthetic-second-session");
    else { expect(cleanup.length).toBeGreaterThan(0); cleanup.forEach((stop:()=>void)=>stop()); }
    f.reply(0, kind === "pins" ? {pins:[{id:1}],truncated:false} : {cells:[{count:1}]});
    await settle(); expect(f.writes).toHaveLength(0); expect(f.snapshots).toHaveLength(0);
    expect(f.requests[0].options.signal.aborted).toBe(true);
  }
});
it.each(["pins", "grid"])("%s never overwrites a newer window and starts no hidden reads", async kind => {
  const f = fixture(); let key = "first";
  f.context.bboxParam = () => key; f.context.gridCacheKey = () => key;
  f[kind](); key = "second"; f[kind]();
  f.reply(0, kind === "pins" ? {pins:[{id:1}],truncated:false} : {cells:[{count:1}]});
  await settle(); expect(f.writes).toHaveLength(0);
  f.reply(1, kind === "pins" ? {pins:[{id:2}],truncated:false} : {cells:[{count:2}]});
  await settle(); expect(f.writes).toHaveLength(1);
  f.context.displayActiveRef.current = false; f[kind](); expect(f.requests).toHaveLength(2);
});
it("backs off empty 200/EOF streams and cancels reconnect work on teardown", async () => {
  const f = leadEventsFixture(); const stop = f.effect();
  for(let i=0;i<5;i++) { await settle(); f.timers.runNext(); }
  await settle(); stop();
  expect(f.timers.delays).toEqual([1000,2000,4000,8000,16000,30000]);
  expect(f.timers.tasks.size).toBe(0);
});
it("resets stream backoff after data arrives, and suppresses inactive subscriptions", async () => {
  let connection = 0;
  const f = leadEventsFixture({fetch: async () => {
    const send = ++connection === 3; let reads = 0;
    return {ok:true,body:{getReader:()=>({read:async()=>send && reads++===0
      ? {done:false,value:new TextEncoder().encode(": ping\n\n")} : {done:true}})}};
  }});
  const stop = f.effect();
  for(let i=0;i<3;i++){await settle();f.timers.runNext();}
  await settle(); stop(); expect(f.timers.delays).toEqual([1000,2000,1000,2000]);
  const hidden=leadEventsFixture({displayActive:false}); hidden.effect(); expect(hidden.connections()).toBe(0);
});

it("a cached grid window retires an older network window before applying the cache", async () => {
  const f=fixture(); let key="network-window"; f.context.gridCacheKey=()=>key;
  f.grid(); key="cached-window";
  f.context.gridCacheRef.current.set(key,{ts:Date.now(),data:{cells:[{count:22}]}});
  f.grid(); expect(f.requests[0].options.signal.aborted).toBe(true);
  f.reply(0,{cells:[{count:11}]}); await settle();
  expect(f.writes).toHaveLength(1);
  expect(f.cache.get(JSON.stringify(["/api/leads/map/grid"]))).toEqual({cells:[{count:22}]});
});
it.each([true,false])("returning to the map reconciles once (viewport=%s)", viewport => {
  const refresh=vi.fn(), invalidate=vi.fn();
  const context={displayActive:false,wasDisplayActiveRef:{current:true},gridCacheRef:{current:new Map([["old",1]])},
    viewportModeRef:{current:viewport},refreshViewportPinsRef:{current:refresh},qc:{invalidateQueries:invalidate}};
  const resume=compile(effects.find((text:string)=>text.includes("wasDisplayActiveRef.current")),context);
  resume();expect(refresh).not.toHaveBeenCalled();expect(invalidate).not.toHaveBeenCalled();
  context.displayActive=true;resume();resume();
  expect(context.gridCacheRef.current.size).toBe(0);
  expect(viewport?refresh:invalidate).toHaveBeenCalledTimes(1);
  if(!viewport) expect(invalidate).toHaveBeenCalledWith({queryKey:["/api/leads/map"]});
});
