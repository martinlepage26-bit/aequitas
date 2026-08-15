import { generateRecommendation } from '../../../../../lib/ai';
import { appendAudit, ensureCaseSeeded, getConsentsMap, getDb, loadCaseState } from '../../../../../lib/db';
import { WorkflowError, assertCanGenerateRecommendation, computeStatus } from '../../../../../lib/workflow';

export async function POST(request, { params }) {
  const { caseId } = await params;
  const database = getDb();
  const caseRow = ensureCaseSeeded(database, caseId);
  if (!caseRow) {
    return Response.json({ message: `No case record exists for ${caseId}.` }, { status: 404 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ message: 'Request body must be JSON.' }, { status: 400 });
  }
  if (body?.role !== 'manager') {
    return Response.json({ message: 'Only the case manager can generate a recommendation.' }, { status: 403 });
  }

  const consents = getConsentsMap(database, caseId);
  const status = computeStatus({
    consumerConsent: consents.consumer,
    retailerConsent: consents.retailer,
    managerConfirmed: Boolean(caseRow.manager_confirmed),
  });

  try {
    assertCanGenerateRecommendation(status);
  } catch (error) {
    if (error instanceof WorkflowError) return Response.json({ message: error.message }, { status: 409 });
    throw error;
  }

  const messages = database
    .prepare('SELECT author_role AS authorRole, text FROM messages WHERE case_id = ? ORDER BY id ASC')
    .all(caseId);

  const result = await generateRecommendation({
    claimValue: caseRow.claim_value,
    caseCategory: caseRow.case_category,
    consumerStance: caseRow.consumer_stance,
    retailerStance: caseRow.retailer_stance,
    caseSummary: caseRow.case_summary,
    messages,
  });

  if (!result.ok) {
    return Response.json({ message: result.message }, { status: 502 });
  }

  const createdAt = new Date().toISOString();
  const write = database.transaction(() => {
    appendAudit(database, {
      caseId,
      actorRole: 'manager',
      eventType: 'recommendation_generated',
      payload: {
        ...result.recommendation,
        model: result.model,
        jurisdiction: result.jurisdiction,
        participationDisclosure: result.participationDisclosure,
      },
    });

    if (consents.consumer || consents.retailer || caseRow.manager_confirmed) {
      if (consents.consumer) {
        database.prepare('UPDATE consents SET granted = 0, withdrawn_at = ? WHERE case_id = ? AND role = ?').run(createdAt, caseId, 'consumer');
      }
      if (consents.retailer) {
        database.prepare('UPDATE consents SET granted = 0, withdrawn_at = ? WHERE case_id = ? AND role = ?').run(createdAt, caseId, 'retailer');
      }
      if (caseRow.manager_confirmed) {
        database.prepare('UPDATE cases SET manager_confirmed = 0 WHERE case_id = ?').run(caseId);
      }
      appendAudit(database, {
        caseId,
        actorRole: 'system',
        eventType: 'consents_reset_new_recommendation',
        payload: { reason: 'A new recommendation replaces the prior proposal; prior consents no longer apply to it.' },
      });
    }
  });
  write();

  return Response.json(loadCaseState(database, caseId));
}
