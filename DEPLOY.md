# Deploying the HomeFront portal → portal.homefrontsolutionsllc.com

> **This file used to describe a Railway deploy. That is not the infrastructure
> this project runs on, and following it wastes an afternoon** — there is no
> Railway service, no `railway.json`-driven build pipeline in use, and no `main`
> branch to push to. It is kept as a pointer so nobody follows the old version
> from a bookmark or a search result.

Production is **Hetzner + Docker Compose + Caddy**, deployed by a manual,
approval-gated GitHub Actions workflow over SSH. Nothing auto-deploys: pushing a
branch — including the default branch — ships nothing.

| What | Where |
|---|---|
| Full setup + architecture | [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) *(canonical)* |
| The deploy workflow | [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) |
| What runs on the box | [`scripts/deploy.sh`](scripts/deploy.sh) |
| Rollback / restore / DR | [`docs/INCIDENT_RUNBOOK.md`](docs/INCIDENT_RUNBOOK.md) |
| DNS | [`docs/DNS.md`](docs/DNS.md) |
| Every env var | [`.env.example`](.env.example) |

When this file and `docs/` disagree, **`docs/` wins**.

## Shipping a release

The default branch is whatever GitHub reports (currently
**`rep-knocking-workflow`**, not `main` or `master` — check before assuming).
The workflow refuses any commit that is not an ancestor of it, and refuses any
commit whose CI run has not succeeded for that **exact** SHA.

```bash
# 1. Land the work on the default branch and let CI finish.
git push origin <default-branch>

# 2. Deploy that exact commit (full 40-character SHA — nothing else is accepted).
gh workflow run deploy.yml -f commit_sha=$(git rev-parse HEAD)

# 3. Watch it.
gh run watch "$(gh run list --workflow=deploy.yml --limit=1 --json databaseId --jq '.[0].databaseId')"
```

The box builds an image tagged with the SHA, keeps the old release serving
during the build, cuts over behind a health check, and **auto-rolls-back to the
previous SHA if health fails**. `scripts/rollback.sh` reverts manually.

## The approval gate is not configured

`deploy.yml` says, in its own header:

> Production is deliberately manual. Configure the `production` environment with
> required reviewers before adding its SSH secrets.

The SSH secrets (`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`,
`DEPLOY_KNOWN_HOSTS`) **are** set. The `production` environment exists but has
**no required reviewers**, so `gh workflow run deploy.yml` deploys straight to
production with no second pair of eyes. Add reviewers under
*Settings → Environments → production → Required reviewers* if you want the gate
the workflow assumes you have.

## Database

SQLite on a persistent volume (`DATA_DIR`, `/data` on the box), with encrypted
pre-release snapshots and scheduled offline backups
(`scripts/backup-offline.sh`). Migrations run on boot and are **additive only**
(`ADD COLUMN` / `CREATE ... IF NOT EXISTS`, idempotent). A destructive change is
never automated — see the approval-gated procedure in
[`docs/INCIDENT_RUNBOOK.md`](docs/INCIDENT_RUNBOOK.md).

One-off maintenance scripts run on the box against that volume, e.g.:

```bash
DATA_DIR=/data npx tsx script/reset-areas.ts --tenant <id>
```

They should default to a dry run and take their own snapshot before writing —
see [`script/reset-areas.ts`](script/reset-areas.ts) for the shape to copy.
