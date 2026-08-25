# One IP, one token, twenty checks

## Outcome

A scan spends exactly one (residential IP, Kinetic token) pair on about 20
checks, then switches BOTH. No token outlives the egress it was minted against,
and no IP carries a second token.

## Context

Owner directive 2026-08-24: "20 checkers per one ip and one token then after
auto switch decodo only simple logic".

The evidence already in the repo agrees. Measured against the live search API,
60 addresses per arm, classifying the response BODY rather than the status:

| arm | real answers |
| --- | --- |
| one token, fresh IP every 20 | 20/60 (33%) |
| one IP, fresh token every 20 | 35/60 (58%) |
| fresh token AND fresh IP every 20 | 60/60 (100%) |

What Kinetic throttles is the PAIR. Tokens being PORTABLE (a token minted on one
IP answers from another, 20/20) was never the same claim as a token being
UNSPENT, and an earlier revision conflated the two.

Before this change both halves already used the number 20 -
`DECODO_CHECKS_PER_IP=20`, `KFS_TOKEN_MAX_CHECKS=20` - but they were two
independent counters over different event streams:

- `server/proxy-fetch.ts` `_checksOnThisIp` counts every proxied non-mint
  request, retries and denials included;
- `server/authorizedTokenPool.ts` counts DISTINCT addresses leased per slot.

So the boundaries drifted, and a fresh token was routinely paired with a
half-spent IP - the 33% arm, not the 100% one. A warm reserve of 40 tokens made
it worse: a generation held dozens of tokens, all minted against whichever IP
happened to be current.

## Safety invariants

- Retirement stays LAZY. The pair boundary must not become a mint storm.
- Rotation stays bounded: the IP already rotates at most once per 20 checks, or
  once per `ROTATE_MIN_INTERVAL_MS` under denials.
- No change to challenge handling, to what counts as evidence, or to egress.

## Milestones

1. `server/proxy-fetch.ts`: `setEgressGenerationHook`, fired from
   `rebuildDispatcher` - the one place the sticky port advances.
2. `server/authorizedTokenPool.ts`: `retireGeneration()`, lazy, returns how many
   tokens it retired.
3. `server/scanner.ts`: register the hook; warm-reserve default 1.
4. Tests: the hook fires on every real IP change and only on a real one; the
   pool re-mints on the next lease; the scanner's registered callback ends the
   generation end to end.
5. Document in `docs/SCAN_OPERATIONS.md` and `docker-compose.production.yml`.

## Progress

- 2026-08-24: implemented and verified in one session.

## Decisions

- ONE direction of coupling, IP to token. The egress counter is a SUPERSET of
  the token's (retries and denials spend it too), so at equal budgets the IP
  always reaches 20 first. Coupling the other way as well would add a second
  trigger for no behaviour.
- Fire from `rebuildDispatcher`, not from the budget check. Every path that
  changes the IP - spent budget, denial streak, sticky window, transport
  handover - ends the generation, and there is exactly one call site to keep
  honest.
- LAZY retirement (slots go EMPTY, next lease mints). A pair boundary costs ONE
  mint when the next check arrives, not a warm-pool refill.
- Warm reserve default 1, down from 40. Under this rule every warm token dies
  with the IP; 40 warm tokens meant 39 mints per generation that never answered
  anything.
- The knobs stay, with one named authoritative (`DECODO_CHECKS_PER_IP`) and the
  token caps demoted to backstops. Removing knobs from a live scanner is a
  bigger risk than documenting which one drives.

## Discoveries

- `AuthorizedTokenPool` already drained one token to its cap before touching the
  next ("sticky reuse", an earlier owner directive), so "one token" was half
  true already. The missing half was that the token boundary and the IP boundary
  were unrelated events.
- A capped-but-READY slot still counts toward the warm deficit in
  `refreshDueSlots`, so full slots were never re-minted; the pool grew a new slot
  per generation instead. Lazy retirement now returns those slots to EMPTY, and
  `ensureWarm` reuses them rather than growing.
- The pool constructor computes `refreshMarginMs` as
  `Math.max(1_000, Math.floor(options.refreshMarginMs))`, which is `NaN` when the
  option is omitted - every slot then fails the freshness filter and `lease()`
  throws `AUTHORIZED_TOKEN_POOL_EMPTY`. TypeScript makes the field required, so
  only an `as any` caller (a test) can reach it. Left alone, recorded here.

## Validation

- `tests/unit/decodo-sticky-port.test.ts` 18 passed, including the reversed
  assertion (see below) and the two hook cases.
- `tests/unit/kinetic-scanner-transport.test.ts` 10 passed, including the end to
  end generation test.
- `bash scripts/agent-verify.sh full`: GREEN, exit 0 - harness validator,
  deployment safety, `npm run check`, `npm run check:fast`, `npm test` 7360/7360
  in 580 files, `npm run build`.

A test was REVERSED, deliberately and in the open. It read:

    it("does not drop the token pool when the egress IP changes")
      expect(typeof pool.invalidateAllForEgressChange,
        "removed: it forced a pointless re-mint on every rotation").toBe("undefined");

That was correct when rotation fired every 10 proxied requests
(`PROACTIVE_ROTATE_EVERY`), nowhere near a pair boundary. It is wrong now that
rotation IS the pair boundary. The replacement asserts the new rule and carries
the history in its comment so the next reader sees why it flipped.

## Recovery

Set `KFS_TOKEN_POOL_WARM_MIN` back up to restore a warm pool, and revert the
`setEgressGenerationHook` registration in `server/scanner.ts` to decouple the
halves. No schema or data effects.

## Result

Shipped and verified locally; see Validation.

Watch for: one extra mint per ~20 checks, visible as
`scan.token.generation_retired` followed by a mint. At the production mint gate
(`KFS_MINT_MIN_INTERVAL_MS=1000`) that is about a second per generation, roughly
4% of a 20-check window at the measured 1.23 s/check - against the 33% to 100%
answer-rate difference the arms measured. If the first check after each rotation
is seen waiting on the mint, the fix is a warm reserve of 2, not a return to 40.
