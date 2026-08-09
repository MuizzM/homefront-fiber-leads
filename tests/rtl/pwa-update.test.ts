// The PWA update flow must judge deploys by VERSION, not lifecycle. A tab that
// reloads right after a deploy (stale-chunk recovery, fresh open) boots the
// NEW build while the OLD worker still controls it; the new worker's install
// used to read as "update ready" and cost that tab a redundant prompt plus a
// pointless second full reload. These tests drive initUpdateFlow with a mock
// container: same-version workers stay silent and never reload the tab, while
// different (or unknowable) versions keep the historical prompt → apply →
// one-reload flow.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initUpdateFlow, applyUpdate, __resetPwaForTest } from "@/lib/pwa";

// Deterministic stand-in for the real MessageChannel: delivery is synchronous,
// so tests never depend on jsdom's port-scheduling internals.
class FakePort {
  other!: FakePort;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  postMessage(data: unknown): void { this.other.onmessage?.({ data }); }
}
class FakeMessageChannel {
  port1 = new FakePort();
  port2 = new FakePort();
  constructor() { this.port1.other = this.port2; this.port2.other = this.port1; }
}

// Answers the GET_VERSION handshake exactly like sw.js — or, with version
// null, plays a worker predating the handshake that never replies.
class FakeWorker extends EventTarget {
  state = "installed";
  posted: unknown[] = [];
  constructor(private version: string | null = null) { super(); }
  postMessage(data: unknown, transfer: unknown[] = []): void {
    this.posted.push(data);
    const port = transfer[0] as FakePort | undefined;
    const isQuery = typeof data === "object" && data !== null
      && (data as { type?: string }).type === "GET_VERSION";
    if (isQuery && port && this.version !== null) port.postMessage(this.version);
  }
  queried(): boolean {
    return this.posted.some((d) => typeof d === "object" && d !== null
      && (d as { type?: string }).type === "GET_VERSION");
  }
}

class FakeRegistration extends EventTarget {
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
}

class FakeContainer extends EventTarget {
  controller: FakeWorker | null = null;
  reg = new FakeRegistration();
  async register(): Promise<FakeRegistration> { return this.reg; }
}

const asContainer = (c: FakeContainer) => c as unknown as ServiceWorkerContainer;

// PAGE_BUILD is what index.html's stamped window.__HFS_BUILD__ carries in prod.
const PAGE_BUILD = "abc123";

let prompts = 0;
const onReady = () => { prompts += 1; };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("MessageChannel", FakeMessageChannel);
  prompts = 0;
  window.addEventListener("hfs:update-ready", onReady);
  window.__HFS_BUILD__ = PAGE_BUILD;
});
afterEach(() => {
  window.removeEventListener("hfs:update-ready", onReady);
  delete window.__HFS_BUILD__;
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
  __resetPwaForTest();
});

// Flush the fire-and-forget decide() chain — runs any pending version-query
// timeout too, so a never-answering worker resolves to "unknown" here.
async function settle() {
  await vi.runAllTimersAsync();
  await Promise.resolve();
}

// A controlled tab whose registration has completed — the post-deploy shape.
async function bootControlledTab(reload = vi.fn()) {
  const container = new FakeContainer();
  container.controller = new FakeWorker("old000");
  await initUpdateFlow(asContainer(container), reload);
  return { container, reload };
}

// Deploy lands while the tab is open: a new worker installs.
async function installNewWorker(container: FakeContainer, worker: FakeWorker) {
  container.reg.installing = worker;
  container.reg.dispatchEvent(new Event("updatefound"));
  worker.state = "installed";
  worker.dispatchEvent(new Event("statechange"));
  await settle();
}

describe("post-deploy tab that already runs the new build", () => {
  it("stays silent: no prompt, no forced takeover, and no reload when the worker takes over", async () => {
    const { container, reload } = await bootControlledTab();
    const sw = new FakeWorker(PAGE_BUILD); // same build the page is running
    await installNewWorker(container, sw);

    expect(sw.queried()).toBe(true);   // the handshake ran…
    expect(prompts).toBe(0);           // …and correctly found nothing to offer
    // No silent SKIP_WAITING either: forcing activation would hard-reload any
    // OTHER tab still on the old build without ever showing it the prompt.
    expect(sw.posted).not.toContain("SKIP_WAITING");

    // The worker activates anyway (tabs closed, or an older tab applied it) —
    // this tab is already current, so the reload must be suppressed.
    container.dispatchEvent(new Event("controllerchange"));
    container.dispatchEvent(new Event("controllerchange"));
    expect(reload).not.toHaveBeenCalled();
  });

  it("a same-build worker already waiting at registration is suppressed too", async () => {
    const container = new FakeContainer();
    container.controller = new FakeWorker("old000");
    container.reg.waiting = new FakeWorker(PAGE_BUILD);
    const reload = vi.fn();
    await initUpdateFlow(asContainer(container), reload);
    await settle();

    expect(prompts).toBe(0);
    container.dispatchEvent(new Event("controllerchange"));
    expect(reload).not.toHaveBeenCalled();
  });

  it("suppression is per-worker: a later, genuinely newer deploy still prompts and reloads", async () => {
    const { container, reload } = await bootControlledTab();
    await installNewWorker(container, new FakeWorker(PAGE_BUILD)); // suppressed
    expect(prompts).toBe(0);

    const next = new FakeWorker("xyz789"); // the NEXT deploy — genuinely new
    await installNewWorker(container, next);
    expect(prompts).toBe(1);

    applyUpdate();
    expect(next.posted).toContain("SKIP_WAITING");
    container.dispatchEvent(new Event("controllerchange"));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("genuine update - a tab actually running an old build", () => {
  it("prompts, applies on tap, and reloads exactly once on controllerchange", async () => {
    const { container, reload } = await bootControlledTab();
    const sw = new FakeWorker("def456"); // a different build than the page's
    await installNewWorker(container, sw);

    expect(prompts).toBe(1);
    applyUpdate();
    expect(sw.posted).toContain("SKIP_WAITING");

    container.dispatchEvent(new Event("controllerchange"));
    container.dispatchEvent(new Event("controllerchange")); // the one-reload latch
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a different-build worker waiting at registration prompts immediately", async () => {
    const container = new FakeContainer();
    container.controller = new FakeWorker("old000");
    container.reg.waiting = new FakeWorker("def456");
    await initUpdateFlow(asContainer(container), vi.fn());
    await settle();
    expect(prompts).toBe(1);
  });
});

describe("unknowable versions fall back to prompting - never to silence", () => {
  it("an unstamped page (dev, or a stamping regression) prompts without querying", async () => {
    delete window.__HFS_BUILD__;
    const { container } = await bootControlledTab();
    const sw = new FakeWorker(PAGE_BUILD);
    await installNewWorker(container, sw);
    expect(sw.queried()).toBe(false); // no page build to compare against
    expect(prompts).toBe(1);
  });

  it("a token that survived unstamped counts as unknown, not as a version", async () => {
    window.__HFS_BUILD__ = "__SW_BUILD__";
    const { container } = await bootControlledTab();
    await installNewWorker(container, new FakeWorker("__SW_BUILD__"));
    expect(prompts).toBe(1);
  });

  it("a worker predating the handshake never answers - timeout, then prompt", async () => {
    const { container } = await bootControlledTab();
    const sw = new FakeWorker(null); // swallows GET_VERSION like old sw.js did
    await installNewWorker(container, sw); // settle() runs out the query timeout
    expect(sw.queried()).toBe(true);
    expect(prompts).toBe(1);
  });
});

describe("first install", () => {
  it("no prompt during install and no reload on the claim", async () => {
    const container = new FakeContainer(); // brand-new device: no controller
    const reload = vi.fn();
    await initUpdateFlow(asContainer(container), reload);

    const sw = new FakeWorker(PAGE_BUILD);
    container.reg.installing = sw;
    container.reg.dispatchEvent(new Event("updatefound"));
    sw.state = "installed";
    sw.dispatchEvent(new Event("statechange")); // still uncontrolled → not an update
    await settle();
    expect(prompts).toBe(0);

    // install → activate → clients.claim() fires controllerchange; the page
    // already runs the code the worker just cached, so no reload.
    container.controller = sw;
    container.dispatchEvent(new Event("controllerchange"));
    expect(reload).not.toHaveBeenCalled();
  });
});
