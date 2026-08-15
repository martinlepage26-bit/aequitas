import { appendAudit, ensureCaseSeeded, getDb, loadCaseState } from '../../../../../lib/db';
import { WorkflowError, assertCanAddMessage, computeStatus } from '../../../../../lib/workflow';

const ROLES = new Set(['consumer', 'retailer', 'manager']);
const MAX_TEXT_LENGTH = 4000;

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

  const { role, text } = body ?? {};
  if (!ROLES.has(role)) {
    return Response.json({ message: 'role must be one of consumer, retailer, manager.' }, { status: 400 });
  }
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) {
    return Response.json({ message: 'text is required.' }, { status: 400 });
  }
  if (trimmed.length > MAX_TEXT_LENGTH) {
    return Response.json({ message: `text must be ${MAX_TEXT_LENGTH} characters or fewer.` }, { status: 400 });
  }

  const consents = database
    .prepare('SELECT role, granted FROM consents WHERE case_id = ?')
    .all(caseId)
    .reduce((acc, row) => ({ ...acc, [row.role]: Boolean(row.granted) }), { consumer: false, retailer: false });
  const status = computeStatus({
    consumerConsent: consents.consumer,
    retailerConsent: consents.retailer,
    managerConfirmed: Boolean(caseRow.manager_confirmed),
  });

  try {
    assertCanAddMessage(status);
  } catch (error) {
    if (error instanceof WorkflowError) return Response.json({ message: error.message }, { status: 409 });
    throw error;
  }

  const createdAt = new Date().toISOString();
  const write = database.transaction(() => {
    database
      .prepare('INSERT INTO messages (case_id, author_role, text, created_at) VALUES (?, ?, ?, ?)')
      .run(caseId, role, trimmed, createdAt);
    appendAudit(database, { caseId, actorRole: role, eventType: 'message_added', payload: { text: trimmed } });
  });
  write();

  return Response.json(loadCaseState(database, caseId));
}
