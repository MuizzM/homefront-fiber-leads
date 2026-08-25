# All carrier traffic goes through Decodo

## Outcome

No carrier request leaves from the machine running the app. Every call to
Kinetic or Frontier egresses through the authorized Decodo proxy, and the paths
that used to go direct are opt-in behind one switch rather than on by default.

## Context

Owner directive, 2026-08-24: "never use residential ip always use decodo".

Decodo's sticky ports ARE residential IPs - that is what the account buys - so
"residential" and "Decodo" name the same egress. The directive is therefore
about the other egress in the system: this box's own connection. Four carrier
paths used it, three of them by default and none of them announced:

| path | egress before | switch before |
| --- | --- | --- |
| `server/scanner.ts` imp-direct mint rung | own IP | `KFS_MINT_IMPERSONATE` (on unless `off`) |
| `server/scanner.ts` legacy direct mint rung | own IP | `KFS_MINT_DIRECT` (on unless `off`) |
| `server/frontierScanner.ts` serviceability | own IP FIRST, proxy on failure | `FRONTIER_DIRECT` (on unless `off`) |
| `server/kineticMarketCatalog.ts` directory poll | own IP, always | none |

Production set none of those three flags, so production minted from the server's
own IP on two rungs before ever reaching Decodo. The local `.env` already had
both mint flags `off`, which is why local minting was Decodo-exclusive - and is
also why the mint wedge in [[mint-transport-wedge]] could stall a whole run.

## Safety invariants

- Direct carrier egress must be opt-IN. A deployment that configures nothing
  gets Decodo.
- The gate lives at the point of egress, not at each call site, so a caller that
  forgets cannot leak.
- No new egress path, no evasion behaviour, no change to challenge handling.
- The measured-best mint path stays reachable for an operator who wants it: one
  env var, not a revert.

## Milestones

1. `server/proxy-fetch.ts`: `directCarrierEgressAllowed()` +
   `directCarrierFetch()`, gated on `CARRIER_DIRECT_EGRESS=on`.
2. `server/scanner.ts`: both direct mint rungs behind the gate; the proxied
   impersonate rung skipped rather than passed `null` when no proxy resolves.
3. `server/curlMint.ts`: refuse a null proxy at the spawn.
4. `server/frontierScanner.ts`: direct-first behind the gate, read at call time.
5. `server/kineticMarketCatalog.ts`: directory poll through `proxyFetch`.
6. `tests/unit/carrier-egress-is-decodo-only.test.ts`: structural rule (no
   carrier module calls the global `fetch`) plus behavioural cover for the
   default and the opt-in.
7. Document in `docs/SCAN_OPERATIONS.md` and `docker-compose.production.yml`.

## Progress

- 2026-08-24: all seven milestones implemented and verified in one session.

## Decisions

- ONE switch for the whole class, not per call site. The tradeoff being made is
  the same everywhere (a clean own-IP request against never exposing our own
  IP), so an operator should reverse it in one place or not at all.
- Only the literal string `on` enables it. A `true`/`1`/`yes` that silently did
  nothing would be worse than an error.
- `directCarrierFetch` throws rather than falling back to the proxy. A caller
  that reached for direct egress meant it; quietly rerouting would hide the fact
  that the gate is on.
- The structural test names carrier modules explicitly rather than pattern
  matching URLs. The leak it has to catch looked like `await fetch(url, init)` -
  no carrier string anywhere in the call - so a URL heuristic would have missed
  the real defect.

## Discoveries

- Mints do NOT spend a residential IP's check budget: `isMintUrl()` excludes
  them from the `DECODO_CHECKS_PER_IP` counter and from the denial-streak
  forgiveness. So the cost of Decodo-only minting is the mint SUCCESS RATE
  (measured ~50% proxied against 6/6 direct with curl-impersonate), not budget.
- `server/kineticMarketCatalog.ts` was the only carrier call with no egress
  switch at all - it would have kept using the box's own IP no matter how the
  flags were set.

## Validation

- `DATA_DIR=<fresh> npx vitest run tests/unit/carrier-egress-is-decodo-only.test.ts`: 9 passed.
- `tests/unit/decodo-sticky-port.test.ts`: 16 passed. Two assertions there
  pinned the old inline `currentEgressProxyUrl()` argument and were updated to
  the new form; the guarantee they enforce (the proxied rung uses the sticky
  egress, never the raw rotating gateway) is unchanged, and one assertion was
  ADDED pinning what now gates the direct rung.
- `bash scripts/agent-verify.sh full`: GREEN, exit 0 - harness validator,
  deployment safety, `npm run check`, `npm run check:fast`, `npm test` 7357/7357
  in 580 files, `npm run build`.
- The first full run FAILED 10 tests across 2 files, and the failure was real
  rather than cosmetic: four suites mock `server/proxy-fetch` with an explicit
  object, and the new gate is evaluated on EVERY mint, so the missing export
  threw inside the mint ladder and changed downstream verdicts (a 403 came back
  `blocked: false`). The mocks now carry `directCarrierEgressAllowed: () => false`
  and a `directCarrierFetch` that throws - the production default, so a test that
  reaches for direct egress fails loudly instead of passing quietly.

## Recovery

`CARRIER_DIRECT_EGRESS=on` restores the previous behaviour without a code
change or a redeploy of new images. Per-path off-switches (`KFS_MINT_DIRECT`,
`FRONTIER_DIRECT`) still work underneath it.

## Result

Shipped and verified locally; see Validation.

Operational consequence to watch: production had never minted through Decodo
exclusively, and the proxied mint measured ~50% success against curl-impersonate
direct's 6/6. Expect more `scan.token.mint_failed` at `kind:"auth"` and a lower
effective mint rate; the wedge fix in [[mint-transport-wedge]] is what keeps a
bad IP from turning that into a stall. If mint throughput becomes the scan
ceiling, the honest options are to raise the token pool's tolerance, or to take
the opt-in back deliberately - not to let it drift back by default.
