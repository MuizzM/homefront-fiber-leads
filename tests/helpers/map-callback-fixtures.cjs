// Execute the actual MapView callbacks with synthetic map/transport boundaries.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const repo = process.cwd();
const requireRepo = createRequire(path.join(repo, 'package.json'));
const ts = requireRepo('typescript');
const sourcePath = path.join(repo, 'client/src/pages/MapView.tsx');
const source = fs.readFileSync(sourcePath, 'utf8');
const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = {};
const effects = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && ['fetchViewportPins', 'fetchViewportGrid'].includes(node.name.text)) {
    callbacks[node.name.text] = node.initializer.arguments[0].getText(sourceFile);
  }
  if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === 'useEffect') {
    const text = node.arguments[0].getText(sourceFile);
    effects.push(text);
    if (text.includes('"/api/leads/events"')) callbacks.leadEventsEffect = text;
  }
  ts.forEachChild(node, visit);
}
visit(sourceFile);
function compile(text, context) {
  if (!text) throw new Error('Requested callback not found in MapView');
  const js = ts.transpileModule(`const callback = ${text};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return vm.runInNewContext(`(() => { ${js}\nreturn callback; })()`, context);
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function timerQueue() {
  let id = 0;
  const tasks = new Map();
  const delays = [];
  return {
    tasks, delays,
    setTimeout(fn, ms) { const key = ++id; tasks.set(key, { fn, ms }); delays.push(ms); return key; },
    clearTimeout(key) { tasks.delete(key); },
    runNext() {
      const next = tasks.entries().next().value;
      if (!next) return false;
      tasks.delete(next[0]); next[1].fn(); return true;
    },
  };
}
function mapFixture(extra = {}) {
  let session = 'synthetic-account-a';
  const requests = [];
  const writes = [];
  const snapshots = [];
  const cache = new Map();
  const timers = timerQueue();
  const window = { minLng: -80.4, minLat: 35.5, maxLng: -80.3, maxLat: 35.6 };
  const context = {
    AbortController, DOMException, Date, Math, Map, Set, Promise, TextDecoder,
    document: { visibilityState: 'visible' }, navigator: { onLine: true },
    user: { id: 1, tenantId: 1 }, tabActive: true, readActive: true, displayActive: true,
    displayActiveRef: { current: true }, windowSnapshotTimerRef: { current: null }, viewportTimerRef: { current: null },
    foregroundActive: true, foregroundOnline: true,
    readActiveRef: { current: true }, foregroundActiveRef: { current: true },
    viewportModeRef: { current: true }, filterSourceRef: { current: 'all' },
    mapRef: { current: { getCenter: () => ({ lng: -80.35, lat: 35.55 }) } },
    currentFetchWindow: () => ({ view: window, window }),
    sourceFilterToMapView: () => undefined, sourceFilterToGridTag: () => undefined,
    bboxParam: w => [w.minLng, w.minLat, w.maxLng, w.maxLat].join(','),
    clampToGridGuard: w => w, gridCellForSpan: () => 0.01,
    gridCacheKey: () => 'synthetic-grid-window', MAP_GRID_CACHE_TTL_MS: 60_000,
    gridCacheRef: { current: new Map() }, gridAbortRef: { current: null },
    viewportAbortRef: { current: null }, inFlightPinKeyRef: { current: null },
    truncationEvidenceRef: { current: null }, windowSeedRef: { current: null },
    pinWindowLandedRef: { current: false }, gridWindowLandedRef: { current: false },
    syncViewportTierLayers() {}, refreshViewportPinsRef: { current() {} },
    keepRegion: view => view,
    unpackMapPins: body => body,
    mergeViewportPins: (prev, pins) => ({ pins, added: pins.length, pruned: prev.length }),
    scheduleWindowSnapshotWrite: (pins, win) => snapshots.push({ pins, win }),
    getStoredSessionId: () => session,
    fetch: (url, options) => {
      const pending = deferred(); requests.push({ url, options, ...pending });
      return pending.promise; // deliberately does not honor abort: commit guards must hold too
    },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    qc: {
      setQueryData(key, value) {
        const k = JSON.stringify(key);
        const next = typeof value === 'function' ? value(cache.get(k)) : value;
        writes.push({ key, value: next }); cache.set(k, next);
      },
      invalidateQueries() {},
    },
    ...extra,
  };
  return {
    context, timers, requests, writes, snapshots, cache,
    pins: compile(callbacks.fetchViewportPins, context),
    grid: compile(callbacks.fetchViewportGrid, context),
    replaceSession(value = 'synthetic-account-b') {
      session = value; cache.clear();
      if (context.requestScope) { context.requestScope.abort(); context.requestScope = new AbortController(); }
    },
    // Locate the actual loader cleanup effect if/when integration adds it.
    installLoaderCleanup() {
      return effects.filter(text => text.includes('viewportAbortRef.current?.abort()')
        || text.includes('gridAbortRef.current?.abort()'))
        .map(text => compile(text, context)()).filter(fn => typeof fn === 'function');
    },
    reply(index, body) {
      requests[index].resolve({ ok: true, status: 200, json: async () => body });
    },
  };
}
function leadEventsFixture(extra = {}) {
  const timers = timerQueue(); let connections = 0;
  const context = {
    AbortController, DOMException, TextDecoder, Math, Date,
    user: { id: 1 }, tabActive: true, readActive: true, displayActive: true, foregroundActive: true,
    foregroundOnline: true, readActiveRef: { current: true },
    document: { visibilityState: 'visible' }, navigator: { onLine: true },
    getStoredSessionId: () => 'synthetic-fixture',
    fetch: async () => {
      connections++;
      return { ok: true, body: { getReader: () => ({ read: async () => ({ done: true }) }) } };
    },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    qc: { invalidateQueries() {} }, ownedJobIdRef: { current: null },
    gridCacheRef: { current: new Map() }, viewportModeRef: { current: false },
    refreshViewportPinsRef: { current() {} },
    ...extra,
  };
  return { timers, context, effect: compile(callbacks.leadEventsEffect, context), connections: () => connections };
}

module.exports = { callbacks, effects, compile, mapFixture, leadEventsFixture, deferred, settle, timerQueue };
