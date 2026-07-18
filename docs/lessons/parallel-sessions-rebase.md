# Multiple agent sessions push to one branch — always fetch+rebase before push, and verify THEIR red CI before assuming a flake.
This repo is worked by parallel Claude sessions. Non-fast-forward pushes are routine;
rebase yours on top and re-run the suite on the MERGED tree. Twice their commits broke
tests (market-count expectations, mint-endpoint spy pollution) — check the actual
failing assertion before rerunning as "flake". Known true flakes: tenant-identity-
payout-isolation, onboarding-approval-route (gh run rerun --failed once).
