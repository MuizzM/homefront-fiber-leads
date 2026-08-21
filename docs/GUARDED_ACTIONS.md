# Guarded actions

One choke point between "somebody asked for this" and "the database changed".

A request enters as an intent. A policy decides whether it runs now, waits for a
second person, or is refused. The execution is journaled with the inverse needed
to reverse it, and for a bounded window an authorized actor can undo it.

Everything here ships behind `GUARDED_ACTIONS_ENABLED`, which is off. With the
flag down every `/api/actions` route answers 404 and no call site routes through
the gate.

## Why it exists

The app already had capabilities: a rule about who may *ask*. It had no rule
about what happens *when they do*. A manager with `lead.assign` could move four
hundred doors in one tap, and the only record was an audit row after the fact.

This layer adds three things capabilities cannot express:

- **Size changes the answer.** Reassigning one door and reassigning somebody's
  whole book are the same capability and not the same risk.
- **Some decisions want two people.** Not as a workflow, as a control.
- **A mistake should be reversible, and where it is not, that should be said out
  loud before the button is pressed.**

## The pieces

| File | What it owns |
| --- | --- |
| [shared/guardedActions.ts](../shared/guardedActions.ts) | The catalogue, the states, and `decideGate` - the whole rulebook, pure |
| [server/guardedActionMigrations.ts](../server/guardedActionMigrations.ts) | Three tables: policy, requests, append-only transitions |
| [server/guardedActionStore.ts](../server/guardedActionStore.ts) | Tenant-scoped persistence |
| [server/guardedActionEngine.ts](../server/guardedActionEngine.ts) | Submit, approve, execute, undo, expire |
| [server/guardedActionExecutors.ts](../server/guardedActionExecutors.ts) | The concrete kinds |
| [server/guardedActionRoutes.ts](../server/guardedActionRoutes.ts) | HTTP, behind the flag |
| [client/src/pages/ActionApprovals.tsx](../client/src/pages/ActionApprovals.tsx) | Queue, history, policy editor |

## The four invariants

Everything else is detail. These are the properties the tests exist to protect.

### 1. The catalogue is a floor, not a default

Every kind declares the loosest gate it may ever run under. Tenant policy can
tighten that and can never loosen it, enforced in `clampPolicy` on the way in
**and** on the way out of the database.

Reading back through the clamp is the part that is easy to miss. A policy row
written before a floor was raised must not keep running under the old rule - the
floor lives in the code, and the code is what is deployed.

`contact.suppression.lift` has a floor of `approval`. An admin who posts
`mode: "auto"` gets `approval` back, saved and echoed, and the screen renders
what was actually stored.

### 2. Undo is a promise, so it is declared per kind

Reversibility is a property of the action, not of the policy.

- **Reversible.** The inverse restores the prior state and that genuinely undoes
  the effect. Reassignment is the example.
- **Irreversible.** Lifting a suppression is the example. Re-adding the row
  restores the block; it cannot recall a message sent while the block was down.

An irreversible kind is never offered an undo, whatever window an admin
configures. A layer that offers undo it cannot honour is worse than one that
offers none, because people approve differently when they believe a mistake is
recoverable.

### 3. The inverse is captured, never re-derived

Every executor reads current values **before** it writes and builds the inverse
from what it saw.

Deriving an inverse at undo time reads a world that has moved on. If a door went
Sam to Alex, and later Alex to Jo, an inverse computed at undo time says "put it
back to Alex" - which is not where it started and not what anyone asked for.

### 4. Undo refuses on drift

`post_fingerprint` hashes the state the execution left behind. Undo recomputes it
and refuses if it has changed, because a changed fingerprint means somebody else
touched the same rows afterwards, and reversing would silently clobber their
work.

The refusal is recorded as an `undo_failed` event. The action stays `executed` -
it did happen, it just was not reversed.

## Registered kinds

| Kind | Floor | Reversible | Request | Approve |
| --- | --- | --- | --- | --- |
| `lead.reassign` | auto | yes | `lead.reassign` | `lead.assign` |
| `lead.bulk_assign` | auto | yes | `lead.assign` | `lead.reassign` |
| `recovery.case.assign` | auto | yes | `recovery.manage` | `recovery.manage` |
| `contact.suppression.lift` | **approval** | **no** | `contact.suppression.manage` | `contact.suppression.manage` |

`lead.bulk_assign` defaults to approval above 200 doors. That number is where a
territory move stops looking like a street and starts looking like somebody's
whole book.

## States

```
pending  -> approved -> executed -> undone
   |          |            |
   |          +-> failed   +-> (stays executed; undo is optional)
   +-> rejected
   +-> expired
```

`rejected` and `expired` never touched the database. `failed` means the executor
was reached and threw; the reason is on the row, which is more useful than a 500
that leaves the queue showing `approved` forever.

## Adding a kind

1. Add it to `GUARDED_ACTION_KINDS` and write its spec in `GUARDED_ACTIONS`.
   Choosing `floor` and `reversibility` is the real work; everything else
   follows.
2. Write an executor implementing `parse`, `magnitude`, `label`, `preflight`,
   `execute`, `fingerprint`, `reverse`. Read before you write, and make the
   fingerprint cover exactly the rows the payload targets - too narrow lets
   drift through, too wide blocks a legitimate undo.
3. Register it in `registerGuardedActionExecutors`.
4. The invariant test in `tests/unit/guarded-action-policy.test.ts` will fail if
   the default is looser than the floor or an irreversible kind carries a
   non-zero undo ceiling.

A kind in the catalogue with no executor returns 500 by design: the catalogue is
what advertises the action exists.

## Wiring an existing route through the gate

`submitGuardedAction` returns `{ status: "passthrough" }` when the flag is off,
so a call site keeps its previous behaviour:

```ts
const result = submitGuardedAction({ kind: "lead.bulk_assign", payload, actor });
if (result.status === "passthrough") {
  // existing code path, unchanged
} else if (result.status === "pending") {
  // queued - tell the caller, and do NOT also do the work
}
```

The one mistake to avoid: treating `pending` as success and running the legacy
path anyway. A queued action that has already happened is not a gate.

## Turning it on

```bash
GUARDED_ACTIONS_ENABLED=true
```

Nothing else. The tables are created by the normal migration path on every boot
whether or not the flag is set, so enabling it does not need a schema step, and
disabling it is a rollback that needs no deploy.

The nav entry is filtered on a live probe of `/api/actions/pending-count` rather
than on the capability alone - with the flag down that endpoint 404s, so a role
holding `action.queue.read` does not get a permanently empty screen. The client
does not probe blind, though: the session payload (`/api/auth/status` and the
login response) carries `guardedActionsEnabled`, and Layout only starts the
poll where it is true. Probing blind meant every flag-off environment logged an
unsuppressable console 404 once a minute for every signed-in approver. The 404
wall itself is unchanged - the flag bit on an authenticated session discloses
nothing that 403-vs-404 on these routes did not already.

## What is deliberately not here

- **No cross-tenant view.** Every read is scoped to the session's organization,
  and out of scope is 404, not 403.
- **No approval delegation or escalation chains.** One capability decides who
  may approve a kind. Chains can come later; they are a workflow feature, and
  this is a control.
- **No notification on a pending request.** The queue polls and the nav badge
  counts. Pushing a notification is a separate decision about interrupting
  people.

## Tests

| Suite | What it proves |
| --- | --- |
| [tests/unit/guarded-action-policy.test.ts](../tests/unit/guarded-action-policy.test.ts) | The rulebook: floors, magnitude, clamping, undo availability |
| [tests/integration/guarded-actions.test.ts](../tests/integration/guarded-actions.test.ts) | The gate end to end, including that a queued action has not already happened |
| [tests/rtl/action-approvals.test.tsx](../tests/rtl/action-approvals.test.tsx) | The screen never offers an undo it cannot honour |
