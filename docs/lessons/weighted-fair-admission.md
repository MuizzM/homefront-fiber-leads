# Priority ordering alone starves; reserve by CAPPING the bulk classes, not by boosting the urgent ones.
Five classes (IMMEDIATE > NEW_BUILD > DISCOVERY > EXPANSION > MAINTENANCE): revenue
classes get guaranteed capacity because EXPANSION (35%) and MAINTENANCE (50%) are
share-capped — the head-selection query EXCLUDES a capped class once it holds its
share, so the next-best uncapped item is admitted instead (returning "not admitted"
would head-of-line-block). Aging lifts long-waiters but is clamped so it can never
invert tiers (a 150-point boost let aged bulk outrank fresh manual — cap it at 15).
Load-test proof: R13 (expansion flood can't starve a 42-scan) + the 5-class test.
