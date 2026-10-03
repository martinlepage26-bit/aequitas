# Aequitas security repair — 2026-10-03

The release is built in `fix/security-auth-and-release-20261003`, in an
isolated worktree. Commit `9c20edb` captures the previously deployed landing,
submission and chronology changes before the security repair. The original
checkout and its existing uncommitted changes are preserved.

## Authentication and access

Session cookies require `purpose: "session"`, a nonempty user ID, an allowed
role and an allowed authentication method. Signed WebAuthn challenges and
invitations cannot become sessions. The signed envelope also requires a valid
expiration. Existing session cookies must be replaced by signing in again.

Passkey sign-in options no longer look up email addresses or disclose a user
ID. The credential and signed assertion determine the user; the requested
email must match that credential's account. Every ceremony checks its own
purpose. Sign-in and invitation activation have a one-minute limit and a
cancel action. French and English sign-in retain the destination and locale;
sign-out clears the session and pending challenge.

Case visibility is checked before disclosing state or recommendations.
Unassigned callers get 404. Authorized administrative workspace, projection,
chronology, timeline and export reads append `ACCESS_STAFF_GRANTED` to the
case's serialized hash chain. Administrative draft visibility remains subject
to the existing quarantine rules.

Respondents named during intake remain account placeholders. Creating one
does not grant a passkey or permission to claim it. Administrators invite
them to activate their accounts; invitations are now stored by token hash,
can be revoked, and are rechecked under the same user row lock as the claim.
Issuing a replacement revokes older unused links. Old stateless invitations
need to be reissued after this release.

## Delivery and DNS

Resend uses server-side `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO` and
`APP_URL`. Martin selected `aequitas@pharos-ai.ca` for both From and Reply-To.
The administrator can choose email delivery or share a claim link manually.
The UI distinguishes provider acceptance, a failure, and missing settings.

Case notifications are written transactionally, then dispatched after commit
to activated accounts. Failures remain pending and can be retried from the
invitation screen. Stable Resend idempotency keys help prevent duplicate
delivery on retries. No case content is included in notification emails.
There is no background retry scheduler in this release.

Gmail forwarding and DNS were not changed. The observed inbound MX records
remain `route2.mx.cloudflare.net` (2), `route3.mx.cloudflare.net` (80), and
`route1.mx.cloudflare.net` (97). Sender-domain verification must be completed
in Resend without replacing the inbound MX records. The provided key is
restricted to sending and cannot query verification status. No live email
was sent as part of deployment verification.

## Hardening and recovery

Responses carry CSP with script nonces, HSTS in production, frame denial,
nosniff, a referrer policy and restrictive camera/microphone/geolocation
permissions. Next.js's powered-by header is disabled. Existing inline styles
are still allowed by the style policy. Malformed percent encodings return
400 instead of an application exception. Invalid invitations use a styled
page with links home and to sign-in.

Railway checks `/api/health`, which checks the database and reports the
deployed `RELEASE_COMMIT`. Failed draft generation restores `POSITIONS` when
no valid draft remains and records `RECOMMENDATION_DRAFT_FAILED`; an existing
draft is retained. Each draft request has an ID, preventing simultaneous
generation or an old failure from reverting a newer result. Expired requests
can be retried after fifteen minutes. Event replay understands recovery.

Evidence is scanned before storage. Failed writes delete the new object;
the transaction rechecks that intake is open. Export-record failures also
delete their new archive. Storage failures during deletion or process death
can still require reconciliation; this release does not install a periodic
storage sweeper.

## Dependencies and infrastructure

Next.js and eslint-config-next are pinned to 16.3.8, Vitest and coverage to
4.1.11, and brace-expansion resolves to 5.0.12. Node is pinned to the 22 line;
npm is pinned to 11.21.0. Compose images use the tested immutable digests and
retain loopback-only ports. GitHub Actions requests only `contents: read`.

The dependency audit reports zero critical, zero moderate and five high
package entries arising from the unpatched development-only `braces`
advisory. npm's suggested Next 14 downgrade was intentionally not applied.

## Product brief

Pass. The feature adds explicit invitation delivery and revocation, login
cancellation, logout and draft recovery. The negligence risk is treating a
successful-looking click as proof of identity, email delivery or AI completion.
Low-effort entry is useful, but the same path now returns a named status and a
reversible next action. It would fail if users were left waiting, falsely told
an email was sent, or unable to revoke access. The reverse hinge is visible
acceptance/failure, cancel/revoke/sign-out controls, and a retryable case with
an attributable event. The minimal artifact is an invitation status or failed
draft event with an explicit next action.

## Validation

Full unit/integration suite: 629 tests passed, including real signed WebAuthn
assertions, token confusion, mid-claim revocation, case-access concealment,
draft concurrency/recovery, and real MinIO/ClamAV rollback checks. Lint, typecheck, translation parity, terminology checks and production build passed.
All 14 distinct browser scenarios passed across the full workflow run and targeted
reruns after correcting test selectors. These cover real virtual-authenticator passkeys,
localized routing, cancellation, sign-out, invitation issuance/revocation,
intake/evidence/chronology/positions and draft privacy; final counts are recorded
in the deployment proof. CodeRabbit review findings were verified and repaired.
