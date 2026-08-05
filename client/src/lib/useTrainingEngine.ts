// ── useTrainingEngine — the coaching engine's shared hooks ───────────────────
// One hook family, consumed by Coach, the deck runner, and Today's WarmupStrip
// so the offline contract (persisted deck snapshot + durable review outbox +
// optimistic ladder) cannot drift between screens.
//
// Server contract (CE-1, mocked in tests):
//   GET  /api/training/deck          → { due: DrillCard[] (≤30), new: DrillCard[] (≤10), dueCount, newCount }
//   POST /api/training/reviews       → { reviews: [{ cardId, grade, reviewedAt, rungBefore? }] } → { ok, updated }
//   GET  /api/training/coach-summary → { dueCount, newCount, streakDays, ladderCoverage, totalCards, cardsReviewedTotal }
//
// Offline is the default state: the deck query is persisted (24h snapshot via
// PERSISTED_QUERY_KEYS), grades append to the trainingReviewQueue outbox AND
// apply the SHARED ladder (shared/trainingSchedule.ts — identical math to the
// server) to a persisted local rung map, so a full dead-zone shift leaves the
// deck, the summary, and the ladder bar correct. The local corpus
// (buildDrillDeck) ships in the JS bundle, so even a cold first launch with no
// snapshot still drills — see the lazy corpus loader below for how that corpus
// reaches the page without riding on every screen that imports this module.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import type { DrillCard } from "@shared/trainingCards";
import { nextRung, MAX_RUNG, type Grade } from "@shared/trainingSchedule";
import {
  getTrainingReviewQueue,
  type QueuedReview,
  type ReviewQueueSnapshot,
} from "@/lib/trainingReviewQueue";

export type DeckMode = "warmup" | "refresher" | "debrief";

/** CE-1 GET /api/training/deck response shape. */
export interface TrainingDeckResponse {
  due: DrillCard[];
  new: DrillCard[];
  dueCount: number;
  newCount: number;
}

/** CE-1 GET /api/training/coach-summary response shape. */
export interface CoachSummaryResponse {
  dueCount: number;
  newCount: number;
  streakDays: number;
  ladderCoverage: Record<string, number>;
  totalCards: number;
  cardsReviewedTotal: number;
}

export type EngineSource = "server" | "snapshot" | "local";

const EMPTY_SNAPSHOT: ReviewQueueSnapshot = { pendingCount: 0, online: true };

/** How many fresh cards a fully-offline first launch deals as the new pile
 *  (matches the server's ≤10 new-card cap). */
const LOCAL_NEW_CAP = 10;

// ── Lazy offline corpus ──────────────────────────────────────────────────────
// The bundled curriculum (shared/trainingContent.ts via shared/trainingCards.ts)
// is ~428 KB of JS — 139 KB gzipped, the single largest chunk in the app. It is
// read on exactly ONE path: a launch with no server and no persisted deck
// snapshot. But this module is imported by WarmupStrip, which Today renders, so
// a STATIC import put that 139 KB on the critical path of the rep's home screen
// and its first bottom tab — a screen that never shows a single card from it.
//
// Importing it dynamically drops it out of Today's static dependency graph
// entirely (Vite only preloads static deps of a route chunk) while keeping the
// offline contract exactly: the moment a hook actually needs the fallback deck,
// it asks for the corpus, and the chunk is already in the SW/HTTP cache for any
// rep who has opened Training or Coach once.
let corpus: readonly DrillCard[] | null = null;
let corpusLoading: Promise<void> | null = null;
const corpusListeners = new Set<() => void>();

function subscribeCorpus(onChange: () => void): () => void {
  corpusListeners.add(onChange);
  return () => { corpusListeners.delete(onChange); };
}
function readCorpus(): readonly DrillCard[] | null {
  return corpus;
}

/** Fetch the offline corpus chunk once. Idempotent and failure-tolerant: a
 *  failed load leaves `corpus` null, which every caller already handles as
 *  "no local fallback available". */
function loadCorpus(): void {
  if (corpus || corpusLoading) return;
  corpusLoading = import("@shared/trainingCards")
    .then((m) => {
      corpus = m.buildDrillDeck();
      for (const listener of corpusListeners) listener();
    })
    .catch(() => { corpusLoading = null; });
}

/** Test-only: drop the loaded corpus so a case can exercise the cold path. */
export function __resetCorpusForTests(): void {
  corpus = null;
  corpusLoading = null;
  corpusListeners.clear();
}

// ── Local ladder state ───────────────────────────────────────────────────────
// Persisted per rep: the rung each card is believed to be on (optimistic,
// server reconciles on next deck fetch), the local-days with ≥1 review (streak
// truth — a missed day resets quietly), and a lifetime review counter. Same
// storage guard as the outbox: first failure degrades to in-memory.
interface LadderState {
  rungs: Record<string, number>;
  reviewDays: string[];
  reviewCount: number;
}

function emptyLadder(): LadderState {
  return { rungs: {}, reviewDays: [], reviewCount: 0 };
}

function loadLadder(key: string): LadderState {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
    if (!raw) return emptyLadder();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.rungs !== "object") return emptyLadder();
    return {
      rungs: parsed.rungs ?? {},
      reviewDays: Array.isArray(parsed.reviewDays) ? parsed.reviewDays : [],
      reviewCount: typeof parsed.reviewCount === "number" ? parsed.reviewCount : 0,
    };
  } catch {
    return emptyLadder();
  }
}

function saveLadder(key: string, state: LadderState): void {
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(key, JSON.stringify(state));
  } catch {
    /* Safari private mode / sandboxed iframe — session-only state is fine. */
  }
}

/** Local calendar day (YYYY-MM-DD) — the streak is a LOCAL-day truth, matching
 *  the Today page's follow-up date rule. */
export function localDayISO(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Consecutive local days with ≥1 review, ending today or yesterday (a rep who
 *  hasn't drilled yet TODAY still holds yesterday's streak — honest, and a
 *  missed day resets quietly rather than loss-shaming). Pure; test-pinned. */
export function computeStreakDays(days: readonly string[], today = localDayISO()): number {
  const set = new Set(days);
  const cursor = new Date(`${today}T12:00:00`); // noon avoids DST edges
  if (!set.has(today)) cursor.setDate(cursor.getDate() - 1); // grace: today not done yet
  let streak = 0;
  for (;;) {
    const iso = localDayISO(cursor);
    if (!set.has(iso)) break;
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/** Ladder coverage (rung → card count) from a rung map — the LadderBar's data. */
export function ladderCoverageFromRungs(rungs: Record<string, number>): Record<string, number> {
  const coverage: Record<string, number> = {};
  for (let r = 0; r <= MAX_RUNG; r++) coverage[String(r)] = 0;
  for (const rung of Object.values(rungs)) {
    const r = Math.min(Math.max(Math.trunc(rung) || 0, 0), MAX_RUNG);
    coverage[String(r)] += 1;
  }
  return coverage;
}

function ownerKeyFor(user: { id?: number; teamMemberId?: number | null } | null | undefined): number | null {
  if (!user) return null;
  if (typeof user.teamMemberId === "number" && user.teamMemberId > 0) return user.teamMemberId;
  return typeof user.id === "number" && user.id > 0 ? user.id : null;
}

/** The shared review outbox for the signed-in rep (null while signed out). */
export function useTrainingQueue() {
  const { user } = useAuth();
  const ownerKey = ownerKeyFor(user);
  return useMemo(() => {
    if (ownerKey == null) return null;
    return getTrainingReviewQueue({
      ownerKey,
      post: (url, body) => apiRequest("POST", url, body).then((r) => r.json()),
    });
  }, [ownerKey]);
}

/** Live outbox snapshot (pendingCount / online) for honest UI affordances. */
export function useTrainingQueueSnapshot(): ReviewQueueSnapshot {
  const queue = useTrainingQueue();
  return useSyncExternalStore(
    useCallback((cb) => (queue ? queue.subscribe(cb) : () => {}), [queue]),
    useCallback(() => (queue ? queue.getSnapshot() : EMPTY_SNAPSHOT), [queue]),
  );
}

/** Due + new drill cards. Source is "server" on a fresh fetch, "snapshot" when
 *  the persisted query cache answered, and "local" when nothing is on disk —
 *  the local corpus still deals up to LOCAL_NEW_CAP new cards so a cold,
 *  fully-offline launch can drill. */
export function useDueCards(): {
  due: DrillCard[];
  newCards: DrillCard[];
  dueCount: number;
  newCount: number;
  source: EngineSource;
  isLoading: boolean;
  isError: boolean;
} {
  const query = useQuery<TrainingDeckResponse>({
    queryKey: ["/api/training/deck"],
    queryFn: () => apiRequest("GET", "/api/training/deck").then((r) => r.json()),
    staleTime: 60_000,
  });

  // Only the no-server-no-snapshot path needs the bundled curriculum. Ask for
  // it there and nowhere else, so the online majority never downloads it.
  const needsCorpus = !query.data && !query.isLoading;
  useEffect(() => { if (needsCorpus) loadCorpus(); }, [needsCorpus]);
  const localCorpus = useSyncExternalStore(subscribeCorpus, readCorpus, readCorpus);

  return useMemo(() => {
    if (query.data) {
      return {
        due: query.data.due ?? [],
        newCards: query.data.new ?? [],
        dueCount: query.data.dueCount ?? (query.data.due ?? []).length,
        newCount: query.data.newCount ?? (query.data.new ?? []).length,
        // dataUpdatedAt > cached at rehydrate: react-query marks persisted
        // snapshots stale; a successful fetch in this session means server.
        source: query.isFetchedAfterMount ? ("server" as const) : ("snapshot" as const),
        isLoading: false,
        isError: false,
      };
    }
    if (query.isLoading) {
      return { due: [], newCards: [], dueCount: 0, newCount: 0, source: "local" as const, isLoading: true, isError: false };
    }
    // Fully offline, no snapshot: the bundled corpus IS the fallback deck. It
    // arrives one tick later now (dynamic chunk), so report isLoading until it
    // lands — WarmupStrip renders nothing while loading, which is the same
    // "no fake zero" behaviour it already had.
    const newCards = (localCorpus?.slice(0, LOCAL_NEW_CAP) ?? []) as DrillCard[];
    return {
      due: [],
      newCards,
      dueCount: 0,
      newCount: newCards.length,
      source: "local" as const,
      isLoading: localCorpus === null,
      isError: true,
    };
  }, [query.data, query.isLoading, query.isFetchedAfterMount, localCorpus]);
}

/** Record a grade: durably enqueue the review (offline-safe), apply the shared
 *  ladder to the persisted local rung map, and optimistically advance the
 *  cached deck snapshot — a graded card leaves the due pile immediately (an
 *  "again" stays due; it resurfaces same-session via the deck runner's retry
 *  loop, not via a cache lie). */
export function useRecordReviews(): {
  recordReview: (card: DrillCard, grade: Grade, mode?: DeckMode) => void;
  pendingCount: number;
} {
  const { user } = useAuth();
  const qc = useQueryClient();
  const queue = useTrainingQueue();
  const snap = useTrainingQueueSnapshot();
  const ownerKey = ownerKeyFor(user);
  const ladderKey = `hf.trainingLadder.v1.${ownerKey ?? "anon"}`;

  const recordReview = useCallback(
    (card: DrillCard, grade: Grade, _mode?: DeckMode) => {
      const reviewedAt = new Date().toISOString();
      const ladder = loadLadder(ladderKey);
      const rungBefore = ladder.rungs[card.id] ?? 0;
      const rungAfter = nextRung(rungBefore, grade);

      // 1) Durable write FIRST — the outbox dedupes identical (cardId,
      //    reviewedAt), so this can never double-count on retry.
      const review: QueuedReview = { cardId: card.id, grade, reviewedAt, rungBefore };
      queue?.enqueue(review);

      // 2) Optimistic ladder + streak truth (local, server reconciles later).
      const today = localDayISO();
      ladder.rungs[card.id] = rungAfter;
      if (!ladder.reviewDays.includes(today)) ladder.reviewDays.push(today);
      ladder.reviewDays = ladder.reviewDays.slice(-62); // two months is plenty
      ladder.reviewCount += 1;
      saveLadder(ladderKey, ladder);

      // 3) Optimistic deck advance on the cached snapshot (and therefore the
      //    persisted copy). "again" keeps the card due — everything else moves
      //    it out of today's pile.
      qc.setQueryData<TrainingDeckResponse>(["/api/training/deck"], (old) => {
        if (!old) return old;
        if (grade === "again") return old;
        const inDue = old.due.some((c) => c.id === card.id);
        const inNew = old.new.some((c) => c.id === card.id);
        if (!inDue && !inNew) return old;
        return {
          ...old,
          due: old.due.filter((c) => c.id !== card.id),
          new: old.new.filter((c) => c.id !== card.id),
          dueCount: inDue ? Math.max(0, old.dueCount - 1) : old.dueCount,
          newCount: inNew ? Math.max(0, old.newCount - 1) : old.newCount,
        };
      });
      // The summary's due count + ladder coverage are stale the moment a grade
      // lands — refetch when online; offline the local fallback recomputes.
      void qc.invalidateQueries({ queryKey: ["/api/training/coach-summary"] });
    },
    [qc, queue, ladderKey],
  );

  return { recordReview, pendingCount: snap.pendingCount };
}

/** Coach summary: due · streak · ladder coverage. Falls back to the LOCAL
 *  ladder map + deck snapshot when the server is unreachable, so the numbers
 *  stay honest offline (a locally-derived summary is labeled source "local"). */
export function useCoachSummary(): {
  summary: CoachSummaryResponse;
  source: EngineSource;
  isLoading: boolean;
} {
  const { user } = useAuth();
  const ownerKey = ownerKeyFor(user);
  const ladderKey = `hf.trainingLadder.v1.${ownerKey ?? "anon"}`;
  const deck = useDueCards();
  const queue = useTrainingQueue();
  const snap = useTrainingQueueSnapshot();
  // useDueCards already kicks the corpus load on the offline path; this just
  // re-renders the summary with the real card total once it lands.
  const localCorpus = useSyncExternalStore(subscribeCorpus, readCorpus, readCorpus);

  const query = useQuery<CoachSummaryResponse>({
    queryKey: ["/api/training/coach-summary"],
    queryFn: () => apiRequest("GET", "/api/training/coach-summary").then((r) => r.json()),
    staleTime: 60_000,
  });

  return useMemo(() => {
    if (query.data) {
      return {
        summary: query.data,
        source: query.isFetchedAfterMount ? ("server" as const) : ("snapshot" as const),
        isLoading: false,
      };
    }
    const ladder = loadLadder(ladderKey);
    const local: CoachSummaryResponse = {
      dueCount: deck.dueCount,
      newCount: deck.newCount,
      streakDays: computeStreakDays(ladder.reviewDays),
      ladderCoverage: ladderCoverageFromRungs(ladder.rungs),
      // 0 until the lazily-loaded corpus lands (and on the online path, where
      // the server's own totalCards is what renders).
      totalCards: localCorpus?.length ?? 0,
      cardsReviewedTotal: ladder.reviewCount,
    };
    return { summary: local, source: "local" as const, isLoading: query.isLoading && deck.isLoading };
    // snap.pendingCount re-derives the local summary as offline grades land.
  }, [query.data, query.isFetchedAfterMount, query.isLoading, deck.dueCount, deck.newCount, deck.isLoading, ladderKey, snap.pendingCount, queue, localCorpus]);
}
