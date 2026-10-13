# Aequitas on CT920: parallel stand-up (aeq-prod)

Stood up 2026-10-12, 9:40 PM ET, by Air on Martin's voice order (relayed by Jade).
**Status: running in parallel. Railway is still production.** Nothing public points here:
no DNS record, no tunnel hostname, ports bound to loopback only.

## What runs

Host: CT920 `workspace-mtl00` (LXC on Proxmox `mtl-00.infrafabric.io`), user `martin`.
Directory: `~/aequitas-prod` (`/home/martin/aequitas-prod`). `/srv` is root-owned and `martin` has
no passwordless sudo, so `/srv/aequitas-prod` wasn't used. Moving the directory is a `mv` plus a `compose up` once someone with root creates `/srv/aequitas-prod`.

| Container | Image | Loopback port | Volume |
|---|---|---|---|
| `aeq-prod-app` | `aeq-prod-app:<release sha>`, built from `src/Dockerfile` (base `public.ecr.aws/docker/library/node:22-bookworm-slim`) | `127.0.0.1:18310 → 3000` | `aeq-prod-evidence:/data` (evidence at `/data/evidence`, same as Railway's `STORAGE_LOCAL_DIR`) |
| `aeq-prod-postgres` | `public.ecr.aws/docker/library/postgres:18` (the same major version as Railway's `postgres-ssl:18`) | `127.0.0.1:18311 → 5432` | `aeq-prod-pgdata:/var/lib/postgresql` (fresh volume, not the pg16 dev one) |
| `aeq-prod-clamav` | `clamav/clamav@sha256:78810772…` (already on the host, no Docker Hub pull) | `127.0.0.1:18312 → 3310` | `aeq-prod-clamav-db` |

Compose project `aeq-prod`, network `aeq-prod-net`. Log rotation is 10 MB × 5. Memory limits are 1 GB each for the app and Postgres, and 3 GB for ClamAV (it was OOM-killed at 1.5 GB while reloading signatures).
Ports 18300–18303 are reserved for the CompassAI/AurorA `pharos-canada` stack, so Aequitas uses 18310–18312.
No object storage is needed: Railway stores evidence on its `/data` volume (`STORAGE_LOCAL_DIR=/data/evidence`), and this setup mirrors that. MinIO isn't deployed.
Untouched: `aequitas-postgres`, `aequitas-minio`, `aequitas-clamav`, `aequitas-audit-run1-*`, and every `ctm-*`, `leadgen-*`, `episteme-*`, `firecrawl` and `fba` container, plus all tunnels and cloudflared configs.

## Config and secrets
`src/deploy/ct920/.env` (chmod 600, owner martin, gitignored by `.env*`):
- **Fresh:** `POSTGRES_PASSWORD`, `DATABASE_URL` (pointing at `aeq-prod-postgres`), `SESSION_SECRET`. At cutover everyone has to sign in again (consistent with D8/R5 on the CompassAI side).
- **Copied from Railway as-is:** `GEMINI_*`, `ANTHROPIC_*`, `AEQUITAS_PIPELINE_ENABLED=true`, `AEQUITAS_PIPELINE_PROVIDER=gemini` (the same flag state as Railway), `AEQUITAS_OCR_LANGUAGES`, locales, `EMAIL_FROM`/`REPLY_TO`, `HASH_CHAIN_GENESIS`, `IP_HASH_SALT`. The last two have to match Railway, otherwise the hash chain and IP hashes won't verify.
- **`RESEND_API_KEY` is blank on purpose** during the parallel run, so a copy of production data can never email real parties. It gets set at cutover.
- **WebAuthn and APP_URL** use the placeholder `https://aequitas.pharos-ai.ca` (D2 pattern, not created). **Decision AQ-D4:** passkeys registered on `aequitas-production-5a0c.up.railway.app` won't work on any other origin. Users re-register, unless Martin first puts a custom domain on Railway and carries it over.

## Start, stop, deploy, rollback
```bash
cd ~/aequitas-prod/src/deploy/ct920
./deploy.sh                          # build from checked-out HEAD, RELEASE_SHA=$(git rev-parse HEAD), up -d, wait for /api/health to report that SHA
docker compose -p aeq-prod ps
docker compose -p aeq-prod logs -f app
docker compose -p aeq-prod stop      # stop (clean SIGTERM exit via scripts/start.mjs)
docker compose -p aeq-prod down      # ROLLBACK: removes only aeq-prod containers; Railway is unaffected (it is parallel)
docker compose -p aeq-prod down -v   # also deletes aeq-prod volumes (data!) — only with intent
curl -s 127.0.0.1:18310/api/health   # {"status":"ok","release":"<sha>"}
```
From the Mac: `ssh -L 18310:127.0.0.1:18310 mtl-00`, then open http://127.0.0.1:18310/fr-CA/auth/sign-in. Passkeys won't work on that origin, so this is for smoke tests only.

## Health release
`/api/health` reports `RAILWAY_GIT_COMMIT_SHA ?? RELEASE_SHA ?? RELEASE_COMMIT`. Railway behaviour is unchanged.
On CT920, `deploy.sh` sets `RELEASE_SHA` from `git rev-parse HEAD`, and it's baked in as a build arg and set as the runtime env. Tests fail on any hardcoded hash in `release.ts`, the health route, the Dockerfile, the compose file and `deploy.sh`.

## Backups (`deploy/ct920/backup.sh`)
Nightly `pg_dump -Fc` plus a tar of the evidence volume and `SHA256SUMS`, written to `~/aequitas-prod/backups/{daily,weekly}`. It keeps 14 daily and 8 weekly copies (Sunday). Proposed cron (not installed until cutover, to avoid backing up a dry-run copy):
`15 3 * * * ~/aequitas-prod/src/deploy/ct920/backup.sh >> ~/aequitas-prod/backups/backup.log 2>&1`
**Off-box target pending:** `penguin-backups` NFS needs root/infra-owner (Dan). The alternative is a second copy to Martin's Mac over NetBird.
Restore test: `verify-restore.sh <dump> [evidence.tar]`.

## Data migration dry-run (`deploy/ct920/verify-restore.sh`)
This restores a `pg_dump -Fc` into `aeq-prod-postgres` and then checks `prisma migrate status`, per-table row counts (`row-counts.sql`), `verify:events` (hash chain plus projections for every case) and `scripts/verify-evidence-files.ts` (re-hashes every evidence file against `EvidenceItem.sha256`/`byteSize`).
Dumps live in `~/aequitas-prod/dumps/` (chmod 600).

## Gated cutover runbook. REQUIRES MARTIN'S EXPLICIT OK, routed through Metal with Argus checking
1. Pre-checks: Earth/Metal PASS on the draft PR, `deploy.sh` healthy on the final SHA, AQ-D4 decided, off-box backup target working, and a test restore passing.
2. Create a Cloudflare Tunnel `aeq-prod` (new config `~/.cloudflared/aeq-prod-config.yml`; existing tunnels untouched) with hostname `aequitas.pharos-ai.ca → http://127.0.0.1:18310`. Optionally put it behind Cloudflare Access during smoke tests.
3. Announce the window. **Write freeze on Railway** (maintenance flag, or scale the app to 0: that's a Railway change, part of the OK).
4. Final `pg_dump -Fc` from Railway, plus a copy of `/data/evidence`, onto CT920.
5. Run `verify-restore.sh final.dump evidence.tar`. Pass means no pending migrations, row counts equal to Railway, verify:events OK and 0 evidence problems.
6. Set `RESEND_API_KEY` and confirm `APP_URL`/`WEBAUTHN_*` match the chosen hostname, then `./deploy.sh`.
7. Switch the link users get to the new hostname. Smoke test: sign-in, evidence upload (ClamAV), a pipeline run, `/api/health`.
8. Install the backup cron. Railway stays untouched as the rollback for 14 days.
9. **Railway shutdown requires Martin's separate explicit OK**, after the rollback window and a final Railway dump.

Rollback at any point before step 7: `docker compose -p aeq-prod down`. After step 7: point the link back to Railway and unfreeze.

## Dry-run and test results, 2026-10-12
See Air's report to Jade (also appended below).
