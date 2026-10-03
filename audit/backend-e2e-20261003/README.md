# Aequitas backend end-to-end audit — 2026-10-03

Release under test: `9c772f16e6eef79c0952188e8c05df92bbb5249a` (Node 22.22.0, npm 11.21.0, Next.js 16.3.8, `next build` + `next start`, i.e. production mode).

* **`REPORT.md`** — the report: scorecard per area, every finding with reproduction, evidence and a proposed fix, and what could not be tested.
* **`evidence/`** — sanitized evidence: vitest JSON per suite, named observations, HTTP exchange logs (cookies, tokens and keys redacted), baseline checks, the repository's own suite, production reachability record, and `reruns/` (single tests executed after the ordered run; see section 7 of the report).
* **`harness/`** — scripts that build and drive the disposable test rig (stub for Resend/Anthropic, stack control, fault injection, DB guard).
* **`/test/audit/`** and **`/vitest.audit.config.mts`** — the black-box HTTP suites. They are not part of `npm test` (they need a running rig) and contain the regression tests for every confirmed finding: a failing test here is a live defect, and it should turn green when the matching fix lands.

Nothing in `src/`, `prisma/`, `next.config.mjs`, CI or deployment configuration was changed.

## What is real and what is mocked

| Component | In this audit |
|---|---|
| Application | Real: `next build` + `next start` (production mode), loopback HTTP |
| PostgreSQL | Real: PostgreSQL 16.14 (distro build), dedicated cluster, dedicated databases (`*_test`), synthetic role |
| Object store | Real MinIO `RELEASE.2025-10-15T17-29-55Z`, built from the pinned upstream commit `9e49d5e7…` via the Go module proxy; and the local-disk backend (the production default) |
| Virus scanner | Real clamd 1.5.4 from the repo's digest-pinned `clamav/clamav` image; signature DB 28087 (2026-08-09) baked into that image — live updates are blocked by egress policy |
| WebAuthn | Cryptographically valid software authenticator (ES256, `none` attestation) driving the server's real `@simplewebauthn/server` verification — not a browser/CDP virtual authenticator |
| Email (Resend) | **Mocked.** `mail.ts` hard-codes `https://api.resend.com`, so a preload rewrites that one URL to a local stub; every other outbound `fetch` is blocked and logged (log was empty) |
| AI (Anthropic) | **Mocked.** Local stub behind `ANTHROPIC_BASE_URL`; no real model, no spend |
| Production (Railway) | **Not reachable** from this sandbox (egress policy: `CONNECT` → 403). Nothing was sent to it |

## Re-running

```bash
export AUDIT_SP=<scratch dir holding env.sh, stack.env, pgpass.txt, pgtestpass.txt, minio.env, bin/minio>   # synthetic secrets, never committed
audit/backend-e2e-20261003/harness/run-all.sh            # reset DBs/storage, start rig, run every suite in order
node audit/backend-e2e-20261003/harness/summarize.mjs    # evidence/summary.{json,md}
```

Single suite against a running rig: `harness/run-suite.sh <s3|local> test/audit/<file>.audit.ts`.
`harness/with-db.sh` refuses to run anything unless the target is one of the three audit databases on the audit cluster (host, port, database name and data directory are checked first); `reset-all.sh` only drops those databases and paths under the scratch directory.
The harness scripts contain absolute paths of the sandbox (`/home/user/aequitas`, `/var/lib/aq-pg-audit`); adjust them to rerun elsewhere.

## Rebuilding the rig

The rig used for this report was torn down after the audit (processes stopped, the audit cluster, object stores, worktree and synthetic credential files deleted); `evidence/` is the retained record. To run the suites again, recreate the following on loopback, with synthetic secrets only:

| Piece | What the scripts expect |
|---|---|
| Scratch directory (`AUDIT_SP`) | `env.sh` (sets `SP`, `REPO`, a `PATH` with npm 11, `bin/` and the PostgreSQL 16 binaries, and `DOCKER_HOST`), `stack.env` (`SESSION_SECRET`, `IP_HASH_SALT`, `STORAGE_ENDPOINT=http://127.0.0.1:9010`, `STORAGE_BUCKET`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`), `minio.env` (MinIO root credentials), `pgpass.txt` (admin role password), `pgtestpass.txt` (`aq_test` password), `bin/minio` |
| PostgreSQL 16 | Cluster at `/var/lib/aq-pg-audit/data` on `127.0.0.1:54329` (socket directory `sock`, log `log/pg.log`), roles `aq_admin` (superuser, used by `reset-all.sh`) and `aq_test` (owner of the databases), databases `aequitas_audit_test`, `aequitas_audit_tamper_test` and, for the repository's own suite, `aequitas_audit_suite_test` |
| ClamAV | A container named `aq-audit-clamav` from the digest-pinned image in `docker-compose.yml`, publishing `127.0.0.1:3310`, on the Docker daemon at `unix:///run/aqd/d.sock` |
| MinIO | `bin/minio` on `127.0.0.1:9010`; `reset-all.sh` creates the bucket |
| Application | Started by `stack.sh server-start <s3\|local> <on\|off>` from a `next build` of the checked-out commit |
