# Evidence, positions and dispute chronology

Sign in, open **My cases / Mes dossiers**, and choose **View / Voir**.
The homepage explains this route; each case now has three persistent section
links with role- and stage-specific guidance. Forms remain visible but disabled
when a submission is unavailable. The UI never grants a permission on its own.

During evidence intake, either case party can attach evidence and add dated
chronology entries. After the assigned manager closes intake, either party can
submit a versioned position. Managers review; they do not submit as a party.

Dispute chronology captures a party's reported calendar date, title, original
description, author, language and submission timestamp. Dates display in UTC
to preserve the entered day in all timezones. The database and audit trail
retain entries rather than overwriting accounts. A clarification is another
entry. No entry is represented as an independently verified fact.

Case activity is a separate automatic log of actions in Aequitas. Chronology
is included in the JSON/PDF export and in server-owned drafting source
snapshots. AI instructions distinguish reported dates from submission dates
and prohibit treating repeated accounts as independent corroboration.

## Anti-Numbing brief

Pass. Easy entry can invite users to defer to the platform and treat a tidy
timeline as established fact. The reverse hinge is a deliberate dated account
with attribution, supporting-evidence guidance, uncertainty disclosure and
visible original submissions. The same low-effort entry leads to one concrete
act of attention: a dated event in the user's own words. Preserve party agency,
human review and the existing explicit consent text; never auto-fill facts.

## Design scope

Brand-preserving, trust-first landing guidance: variance 4, motion 2, density
4. Reuse the existing photograph, slate-blue palette and typography. The
frontend-design skill is limited to the landing surface; the case workspace
uses accessible labelled form controls and scoped product CSS.

## Verification

Run `npx vitest run test/unit test/integration/chronology.test.ts
test/integration/knowledge-export.test.ts` for date validation, access and state
guards, audit replay, database immutability and JSON/PDF export coverage.
The tests require the existing isolated PostgreSQL test database; PDF text
verification also requires `pdftotext`.

The bilingual browser flow uses `playwright.submissions.config.ts`. Point
`AEQUITAS_SUBMISSION_BUILD_DIR` at a separately built production snapshot,
then run `npx playwright test --config=playwright.submissions.config.ts`.
Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` if using system Chromium. The dedicated
config refuses to reuse an existing developer server and applies the test
database guard to both fixtures and the application. Accessibility checks
use the axe-core already supplied by the existing lint dependencies.

The private demo migration is additive. Back up its database before applying
`20261001014000_dispute_chronology`; never reset or reseed existing records.
Keep a production-build rollback without touching `.next/dev`.

## Observation 1: Verify the task entry path, not only the visual surface

**Date:** 2026-10-01
**Status:** OPEN
**Skill:** design-taste-frontend
**Type:** open-source
**Phase/Area:** Redesign pre-flight and navigation

**Issue:** A visual refresh passed its layout checks, but a user still could
not identify where to perform the primary product actions.

**Suggested improvement:** Extend the navigation pre-flight with a real-user
task walkthrough, including signed-out entry, role restrictions and inactive
workflow stages. Verify promised capabilities exist as actual inputs.

**Principle:** A polished surface is not usable if the route from its promise
to the user's next action is hidden or absent.

This is an observation artifact, not task authority. A broader skill-library
review is outside this application fix; no skills or schedules were changed.
