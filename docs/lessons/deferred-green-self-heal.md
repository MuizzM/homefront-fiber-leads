# Never drop a trigger because capacity was full at that instant — sweep for uncovered work every tick.
onFreshLead returned at_active_cap/backpressure and recorded NOTHING, permanently
dropping a confirmed green lead's expansion exactly when leads poured in fastest. The
robust fix wasn't wiring every publication path (4 of them, cycle risk): a per-tick
sweep (retryDeferredGreens) finds recent greens with no cluster and seeds them when
capacity frees. One idempotent reconciler beats N wire points. Same pattern healed the
3 unwired lead-publication paths for free.
