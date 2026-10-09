# Phase 1 — Traceable core

Phase 1 adds claim, source, evidence-link, relationship, and review records on top of the live dispute case. It does not replace the consumer dispute flow, the case states (`DRAFT` through `CLOSED`), consent-based resolution, WebAuthn, or the hash-chained `Event` log.

## What a reviewer can do

The case manager assigned to a case (the reviewer role) can record:

- a source, pointing at an existing evidence item or at a statute / legal-framework citation
- a claim (`factual`, `causal`, `moral`, `identity`, `policy`, or `impact_statement`), with confidence and a rationale
- a claim–source link that must include a verbatim excerpt
- a relationship between two claims (`supports`, `contradicts`, `qualifies`, `interprets`, and the other predicates in the handoff)
- a review note (`noted` or `edited`)

Each of those writes appends an attributed event (`SOURCE_RECORDED`, `CLAIM_RECORDED`, `CLAIM_UPDATED`, `CLAIM_EVIDENCE_LINKED`, `CLAIM_RELATIONSHIP_RECORDED`, `REVIEW_RECORDED`). Those events do not change `Case.state`. `verifyCase` still recomputes the hash chain.

Parties can read claims about their case and open “Why does Aequitas say this?” to see the source, the excerpt, and who recorded it. Administrators can read and cannot author.

## Rules the server enforces

- A claim with no evidence link whose excerpt is non-blank renders only as needing evidence. It is not shown as something Aequitas says.
- An impact statement is stored as reported experience. It is never shown or scored as a factual claim.
- Approver sign-off and contestation are not implemented here. See `DECISIONS.md`.

There are no LLM calls on this path. Claim text is entered by a person.
