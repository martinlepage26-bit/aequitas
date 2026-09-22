import "../src/lib/loadEnv";
import { draftRecommendation } from "../src/ai/draftRecommendation";
import { validateExplanationRecord } from "../src/domain/explanationRecord";

// Synthetic information only; this script never reads case or participant records.
async function main() {
  if (!process.env.ANTHROPIC_API_KEY || !process.env.ANTHROPIC_MODEL) {
    console.error("BLOCKED: configure server-side ANTHROPIC_API_KEY and ANTHROPIC_MODEL, then rerun npm run smoke:core-ai. No AI request was sent.");
    process.exitCode = 2; return;
  }
  const result = await draftRecommendation({
    locale: "en-CA", category: "EMPLOYMENT", complainantEvidence: [], respondentEvidence: [],
    complainantPosition: { id: "synthetic-position-a", partyRole: "complainant", body: "I felt excluded when the team changed the meeting time. I think the scheduling policy changed, but I have not seen a written policy.", locale: "en-CA", version: 1 },
    respondentPosition: { id: "synthetic-position-b", partyRole: "respondent", body: "The written scheduling policy did not change. I believe the meeting moved because of room availability. We have not yet located the booking records.", locale: "en-CA", version: 1 },
    legalResearch: [],
  });
  if (!result.ok) { console.error(result.reason); process.exitCode = 1; return; }
  const error = validateExplanationRecord(result.explanation);
  if (error) { console.error(error); process.exitCode = 1; return; }
  console.log(JSON.stringify({ ok: true, model: result.explanation.model, method: result.explanation.conflict_knowledge?.method_version, claimCount: result.explanation.conflict_knowledge?.claims.length, sourceCount: result.explanation.knowledge_sources?.length, reviewer: result.explanation.reviewer }, null, 2));
}
main().catch(() => { console.error("The synthetic AI smoke check failed; no case records were read or written."); process.exitCode = 1; });
