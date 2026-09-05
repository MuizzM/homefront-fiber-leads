// ── The bundled training corpus, loaded on demand ────────────────────────────
// shared/trainingContent.ts is the authored curriculum: ~428 KB of JS, 139 KB
// gzipped, the single largest chunk in the app. shared/trainingCards.ts indexes
// it into the drill deck. Anything that STATICALLY imports either one puts that
// 139 KB into its route's preload graph — which is how the rep's home screen
// ended up downloading the whole curriculum to render a card that shows two
// numbers from an API.
//
// This module is the one place that reaches for it, dynamically. Screens ask
// for the corpus when they are actually going to read it; the chunk downloads
// in parallel with the page instead of gating it, and is served from the HTTP
// and service-worker caches on every later visit.
//
// The offline contract is intact. Everything here is still BUNDLED — no network
// call, no server dependency — so a dead-zone rep who has opened Coach or
// Training once has the whole curriculum on device, exactly as before.
import { useEffect } from "react";
import { useSyncExternalStore } from "react";

type TrainingCardsModule = typeof import("@shared/trainingCards");

let corpus: TrainingCardsModule | null = null;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => { listeners.delete(onChange); };
}

function read(): TrainingCardsModule | null {
  return corpus;
}

/** Start the corpus download. Idempotent, and failure-tolerant: a failed load
 *  leaves the corpus null, which every caller treats as "not available yet". */
export function loadTrainingCorpus(): void {
  if (corpus || pending) return;
  pending = import("@shared/trainingCards")
    .then((m) => {
      corpus = m;
      for (const listener of listeners) listener();
    })
    .catch(() => { pending = null; });
}

/**
 * The corpus module, or null until it lands. Pass `enabled` false to subscribe
 * without triggering the download — useful for a component that renders long
 * before the corpus is needed.
 */
export function useTrainingCorpus(enabled = true): TrainingCardsModule | null {
  const value = useSyncExternalStore(subscribe, read, read);
  useEffect(() => { if (enabled) loadTrainingCorpus(); }, [enabled]);
  return value;
}
