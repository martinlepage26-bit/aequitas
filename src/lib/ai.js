import Anthropic from '@anthropic-ai/sdk';
import { JURISDICTION, PARTICIPATION_DISCLOSURE, PROVISIONS, STATUTE } from './legalFramework';

const RECOMMENDATION_SCHEMA = {
  type: 'object',
  properties: {
    proposalText: {
      type: 'string',
      description: 'The proposed resolution, one or two sentences, addressed to both parties.',
    },
    rationale: {
      type: 'array',
      items: { type: 'string' },
      description: '2-4 short points explaining why this is proposed, grounded only in the given case facts.',
    },
    proposedAction: {
      type: 'string',
      description:
        'A short, concrete description of what would need to happen operationally if this is agreed (e.g. what ships, what is waived, what is refunded) — for the case record, not an instruction to actually carry it out.',
    },
    limits: {
      type: 'string',
      description:
        'One or two sentences on what this recommendation does NOT establish and what the case manager must still verify. Must state plainly that this is a draft, not a legal determination, and that participation is voluntary.',
    },
  },
  required: ['proposalText', 'rationale', 'proposedAction', 'limits'],
  additionalProperties: false,
};

const inForceProvisions = PROVISIONS.filter((p) => p.inForce)
  .map((p) => `${p.section}: ${p.summary}`)
  .join('\n');

const SYSTEM_PROMPT = `You are drafting a candidate resolution recommendation for a consumer dispute case-management workspace. Your output is a DRAFT for a human case manager to review, edit, or reject — it is never an automatic decision, a legal determination, or a statement that any party has complied with the law. Ground every claim only in the case facts you are given; if the facts are insufficient to propose something concrete, say so plainly in the limits field rather than inventing detail.

This case is governed by the law of ${JURISDICTION.label}: the ${STATUTE.name} (${STATUTE.citation}). Relevant provisions:
${inForceProvisions}

Two things you must get right because they are easy to get wrong by defaulting to other jurisdictions' rules:
1. There is no fixed remedy sequence here (unlike, e.g., a UK-style "repair first, then replace, then refund" ladder). Repair, price reduction, and contract resolution (refund) are alternative remedies under s. 272 — pick whichever best fits the severity of the defect described, and do not imply the others were unavailable or exhausted.
2. This process is entirely voluntary and is not binding arbitration. Never write or imply that accepting this proposal is mandatory, final, or a substitute for the consumer's right to the Office de la protection du consommateur or the courts. The limits field must reflect this.

Do not claim impartiality, statutory compliance, or absence of bias — those are conclusions a human reviewer must reach, not something you can assert about yourself.`;

function buildUserPrompt({ claimValue, caseCategory, consumerStance, retailerStance, caseSummary, messages }) {
  const transcript = messages.map((m) => `${m.authorRole}: ${m.text}`).join('\n');
  return `Case category: ${caseCategory}
Claim value: $${claimValue.toFixed(2)}
Consumer position: ${consumerStance}
Retailer position: ${retailerStance}
Case summary: ${caseSummary}

Case record so far:
${transcript}

Draft one candidate resolution recommendation for the assigned case manager to review.`;
}

export async function generateRecommendation(caseFacts) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      message: 'AI recommendation is unavailable: ANTHROPIC_API_KEY has not been configured for this environment.',
    };
  }

  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-5';

  let response;
  try {
    response = await client.messages.create({
      model,
      max_tokens: 4096,
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: RECOMMENDATION_SCHEMA },
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(caseFacts) }],
    });
  } catch (error) {
    return { ok: false, message: `AI recommendation request failed: ${error.message || 'unknown error'}` };
  }

  if (response.stop_reason === 'refusal') {
    return { ok: false, message: 'The recommendation request was declined by safety review. Draft a recommendation manually.' };
  }

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock) {
    return { ok: false, message: 'The AI response did not include a recommendation.' };
  }

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    return { ok: false, message: 'The AI response could not be parsed as structured output.' };
  }

  return {
    ok: true,
    recommendation: parsed,
    model,
    jurisdiction: JURISDICTION.id,
    participationDisclosure: PARTICIPATION_DISCLOSURE,
  };
}
