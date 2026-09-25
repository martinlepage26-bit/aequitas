# Private demo on CT920

A loopback-only demo of Aequitas, reached from Martin's Mac through an SSH
tunnel. Simulated data only. Nothing here is public hosting (see "Before any
public hosting" in the demo-readiness diagnosis).

## What runs where

| Piece | Where |
|---|---|
| App | `aequitas-demo.service` (systemd `--user`, user `martin`), `next start -H 127.0.0.1 -p 3417` from `/home/martin/Applications/aequitas` |
| Demo env file | `~/.secrets/aequitas-demo.env` (mode 600): `DATABASE_URL` (database `aequitas_demo`), its own `SESSION_SECRET` and `IP_HASH_SALT`, `STORAGE_BUCKET=aequitas-demo`, `WEBAUTHN_RP_ID=localhost`, `WEBAUTHN_ORIGIN=http://localhost:3417` |
| Everything else | `.env.local` (storage endpoint and keys, ClamAV, Anthropic key and model). Next loads it but never overrides a variable already set by the unit's `EnvironmentFile`. |
| Database | `aequitas_demo` on the docker-compose Postgres (127.0.0.1:5433). Dev (`aequitas`) and test (`aequitas_test`) are separate databases. |
| Evidence files | MinIO bucket `aequitas-demo` (separate from the dev bucket) |

## Reach it from the Mac

```bash
ssh -N -L 3417:127.0.0.1:3417 mtl-00
```

Then open **http://localhost:3417** (it redirects to `/fr-CA`). Use
`localhost`, not `127.0.0.1`: the passkey relying-party ID is `localhost`.
Use Chrome (or Firefox). The demo runs with `NODE_ENV=production`, so the
session cookie is `Secure`; Chrome and Firefox accept that on
`http://localhost`, Safari may not (not verified).

## Sign in for a demo

The seed pre-provisions four accounts (fictional people, `.example` domain):

| Role | Email | Locale |
|---|---|---|
| Complainant | `plaignante@aequitas-demo.example` | fr-CA |
| Complainant | `complainant@aequitas-demo.example` | en-CA |
| Respondent | `intimee@aequitas-demo.example` | fr-CA |
| Case manager | `gestion@aequitas-demo.example` | fr-CA |

Accounts are claimed with a passkey through a single-use invitation link
(self-registration can no longer attach a passkey to an existing email, and
cannot create case managers):

1. On the server, read the links yourself (they are not printed by any tool):
   `cat ~/.secrets/aequitas-demo-invites.txt`. One line per account; replace
   nothing, the links already point at `http://localhost:3417`.
2. With the tunnel up, open a link on the Mac and press **Créer ma clé
   d'accès / Create my passkey**. macOS asks for Touch ID (iCloud Keychain or
   the Chrome profile stores the passkey). You land on the case list, signed in.
3. Repeat for each account. Each link works once, and expires after 72 h.
4. To switch accounts later, go to http://localhost:3417/auth/sign-in, enter
   the account's email and confirm with its passkey.

Expired or lost links: re-run the seed (below). It issues fresh links for
every account that has no passkey yet and leaves the rest alone. Rotating
`SESSION_SECRET` in the env file voids every outstanding link and session.

After the demo, delete the four `localhost` passkeys from the Mac's password
manager if you do not want to keep them.

## Seeded cases (all simulated)

| Reference | Category | State | Complainant |
|---|---|---|---|
| AE-DEMO-001 | Retail | DRAFT (not yet submitted) | fr-CA |
| AE-DEMO-002 | Tenancy | OPEN, unclaimed: the manager can claim it | fr-CA |
| AE-DEMO-003 | Freelance | EVIDENCE_INTAKE, one PDF from the complainant | en-CA |
| AE-DEMO-004 | Retail | POSITIONS, evidence and positions from both parties: ready for "request draft" | fr-CA |
| AE-DEMO-005 | Employment | POSITIONS, complainant position only | en-CA |

"Request a draft" calls the Anthropic API (billed) once per click.

## Operate

```bash
systemctl --user status aequitas-demo.service
journalctl --user -u aequitas-demo.service -f
# after code changes: rebuild, then restart
NEXT_BUILD_CPUS=4 npm run build && systemctl --user restart aequitas-demo.service
```

`NEXT_BUILD_CPUS` caps build workers: CT920's shared task limit made a
default build fail with "OS can't spawn worker thread".

## (Re)seed

The seed refuses to run without the confirm variable, and refuses any
database other than `aequitas_demo`:

```bash
cd /home/martin/Applications/aequitas
set -a; . ~/.secrets/aequitas-demo.env; set +a
npx prisma migrate deploy
npm run ensure:storage-bucket
AEQUITAS_DEMO_SEED_CONFIRM=seed-aequitas-demo npm run seed:demo
npm run verify:events   # checks the demo database's hash chains
```

To start over from nothing, drop and recreate the demo database
(`docker exec aequitas-postgres dropdb -U aequitas aequitas_demo`, then
`createdb`), then run the block above.

## Issue one more invitation

As an admin through `POST /api/auth/invite`, or on the server:

```bash
set -a; . ~/.secrets/aequitas-demo.env; set +a
npx tsx scripts/issue-invite.ts someone@aequitas-demo.example RESPONDENT "Nom (démo)" fr-CA
```

It prints a path; open `http://localhost:3417<path>`.
