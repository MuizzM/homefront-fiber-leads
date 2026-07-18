# A "retry forever, never conclude" policy for provider non-answers silently ate 30% of scan capacity — cap attempts, conclude a DATA verdict (not a serviceability one), park with a re-probe window.
Profiling prod scan_events found 576 errors vs 56 classifications per 15 minutes:
~90% of checks were `AddressNeedsFix` non-answers (Kinetic's response when the
queried address string is not in its fabric database — OSM fringe addresses,
out-of-footprint towns). The policy "never conclude no-service from an
infrastructure-ish failure" was correct, but its implementation — requeue with
backoff, no attempt limit — meant 30,385 targets stuck at 8+ attempts re-burned
Decodo checks indefinitely with zero yield, and their runs could never complete.

The fix threads the needle between two laws ("never mark infrastructure errors
as NO_SERVICE" vs "a run must drain"):
- After ADDRESS_NOT_FOUND_ATTEMPTS (6) needs-fix non-answers with no adoptable
  suggestion, finalize the target as conclusive `address_not_found` — a verdict
  about the ADDRESS STRING (already in the classification vocabulary for
  Kinetic's own AddressNotFound), never `no_service`. The run counts it failed/
  unresolved and completes.
- Park: reuse the existing `inconclusive_attempts >= INCONCLUSIVE_GIVEUP`
  exhaustion mechanism — bulk claims (`claimRunTargets` with skipSec>0) skip
  parked targets for ADDRESS_NOT_FOUND_QUIET_DAYS (14), then re-probe (fabric
  imports DO add streets). Manual/lasso/recheck kinds pass skipSec=0 and always
  re-verify — a rep's tap is never blocked by the park.
- Boot backfill: the already-exhausted tail is terminalized from its RECORDED
  history (attempt_count + last_error_message) without burning one more check
  per address.

General lesson: an unbounded retry policy needs a terminal state per failure
CLASS. "This address doesn't exist in the provider's world" is evidence-backed
data after N independent attempts across rotated sessions — refusing to record
it doesn't protect correctness, it just converts capacity into heat, forever.
