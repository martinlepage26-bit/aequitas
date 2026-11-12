# CT920 credential separation

`deploy.sh` requires three distinct regular files in this directory, each mode
0600. There is no fallback from `.env.runtime` to `.env`. All `.env*` files at
any depth are excluded from the Docker build context. Keep authoritative secret
copies in the operator's private store; materialize these deployment copies only
on the approved host. Never source them, commit them, or print their values.

| File | Used by | Contents |
| --- | --- | --- |
| `.env` | Compose interpolation only | Existing `POSTGRES_PASSWORD`; scheduler's explicit runtime settings; `RETENTION_ENFORCEMENT_ENABLED`. Its `DATABASE_URL` must also be the restricted runtime connection for direct Compose operations. |
| `.env.runtime` | Web app and read-only role verifier | Restricted `DATABASE_URL` and existing web settings. No PostgreSQL owner/password, purger, migration, `DIRECT_URL`, or `SHADOW_DATABASE_URL` settings. |
| `.env.migrations` | Ephemeral migration runner only | Exactly one `DATABASE_URL` for the database owner. No provider, mail, session or storage credentials. |

Both connection URLs must be single, unquoted `DATABASE_URL=postgresql://...`
lines without whitespace. Percent-encode password characters for URLs. Keep
runtime and owner connections distinct. The script checks keys without sourcing
files and never puts connection values in command arguments or diagnostics.

Prepare runtime settings by selectively copying the existing web settings in an
owner-only editor. Preserve `SESSION_SECRET`, `IP_HASH_SALT`, `HASH_CHAIN_GENESIS`,
`AEQUITAS_EMAIL_OUTBOX_ENCRYPTION_KEY`, `APP_URL` and WebAuthn RP/origin values.
An ordinary rollout must not rotate keys, invalidate sessions, reissue passkeys,
change account rows, or reset passwords. Keep the outbox key identical in runtime
and Compose control files. The scheduler continues to receive only its explicit
Compose whitelist; when invoking `deploy.sh`, its database URL is pinned to the
runtime file even if the shell inherited a stale owner URL.

After building the image, deployment stops both app and scheduler, waits for
PostgreSQL and ClamAV, runs migrations with only `.env.migrations`, and verifies
the runtime role before starting the app. Runtime may not own the database,
public objects/schema/functions, have elevated attributes or role memberships,
create in `public`, or execute the purge function. With retention enabled the
purge function must belong to the restricted `aequitas_erasure_owner` NOLOGIN
role with no members. The application and scheduler see the independent ledger
read-only; only a separately controlled operator runner may mount it writable.

For the first role split, stop writers and take a consistent database/evidence
backup. Using the existing owner connection, create distinct restricted runtime
and purger login roles, apply migrations in the dedicated runner, grant runtime
DML/sequence permissions, and run `deploy/retention/provision-purger.sql`. Grant
future runtime permissions with owner-specific `ALTER DEFAULT PRIVILEGES` (or
repeat reviewed grants after each migration). Do not put owner credentials in the
web environment to work around a failed migration. Initialize and independently
replicate the deletion ledger before enabling retention. Only then invoke
`deploy.sh`; the migration step is a no-op if the bootstrap already applied it.

On any failure after writers have been stopped, deployment asks both app and
scheduler to stop again and reports if that fails. It never rolls back SQL or
starts the old image. After any migration attempt, an old-image restart requires
explicit schema/data compatibility evidence, or a separately approved consistent
restore. A restore must retain/replay the latest independent deletion ledger.
