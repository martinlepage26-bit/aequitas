import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CASE_ID } from './constants';
import { STATUS, computeStatus } from './workflow';

const DB_PATH = path.join(process.cwd(), 'data', 'aequitas.db');
const GENESIS_HASH = '0'.repeat(64);

const SEED_CASE = {
  caseId: DEFAULT_CASE_ID,
  caseCategory: 'Consumer goods',
  claimValue: 299,
  consumerStance: 'Requests a refund',
  retailerStance: 'Offers repair',
  caseSummary: 'The consumer reports a technical failure and requests a refund. The retailer has offered a repair. The parties have not reached agreement.',
};

let db;

function init() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const instance = new Database(DB_PATH);
  instance.pragma('journal_mode = WAL');
  instance.exec(`
    CREATE TABLE IF NOT EXISTS cases (
      case_id TEXT PRIMARY KEY,
      case_category TEXT NOT NULL,
      claim_value REAL NOT NULL,
      consumer_stance TEXT NOT NULL,
      retailer_stance TEXT NOT NULL,
      case_summary TEXT NOT NULL,
      manager_confirmed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT NOT NULL REFERENCES cases(case_id),
      author_role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS consents (
      case_id TEXT NOT NULL REFERENCES cases(case_id),
      role TEXT NOT NULL,
      granted INTEGER NOT NULL DEFAULT 0,
      granted_at TEXT,
      withdrawn_at TEXT,
      PRIMARY KEY (case_id, role)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT NOT NULL REFERENCES cases(case_id),
      actor_role TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL
    );
  `);
  return instance;
}

export function getDb() {
  if (!db) db = init();
  return db;
}

function computeHash({ prevHash, caseId, actorRole, eventType, payloadJson, createdAt }) {
  return crypto
    .createHash('sha256')
    .update(`${prevHash}|${caseId}|${actorRole}|${eventType}|${payloadJson}|${createdAt}`)
    .digest('hex');
}

export function appendAudit(database, { caseId, actorRole, eventType, payload }) {
  const prevRow = database
    .prepare('SELECT hash FROM audit_log WHERE case_id = ? ORDER BY id DESC LIMIT 1')
    .get(caseId);
  const prevHash = prevRow ? prevRow.hash : GENESIS_HASH;
  const createdAt = new Date().toISOString();
  const payloadJson = JSON.stringify(payload ?? {});
  const hash = computeHash({ prevHash, caseId, actorRole, eventType, payloadJson, createdAt });
  database
    .prepare(
      'INSERT INTO audit_log (case_id, actor_role, event_type, payload, created_at, prev_hash, hash) VALUES (?,?,?,?,?,?,?)'
    )
    .run(caseId, actorRole, eventType, payloadJson, createdAt, prevHash, hash);
  return { createdAt, hash };
}

export function verifyAuditChain(database, caseId) {
  const rows = database
    .prepare('SELECT * FROM audit_log WHERE case_id = ? ORDER BY id ASC')
    .all(caseId);
  let expectedPrev = GENESIS_HASH;
  for (const row of rows) {
    if (row.prev_hash !== expectedPrev) return false;
    const recomputed = computeHash({
      prevHash: row.prev_hash,
      caseId: row.case_id,
      actorRole: row.actor_role,
      eventType: row.event_type,
      payloadJson: row.payload,
      createdAt: row.created_at,
    });
    if (recomputed !== row.hash) return false;
    expectedPrev = row.hash;
  }
  return true;
}

export function ensureCaseSeeded(database, caseId) {
  const existing = database.prepare('SELECT * FROM cases WHERE case_id = ?').get(caseId);
  if (existing) return existing;
  if (caseId !== SEED_CASE.caseId) return null;

  const createdAt = new Date().toISOString();
  const insertCase = database.prepare(`
    INSERT INTO cases (case_id, case_category, claim_value, consumer_stance, retailer_stance, case_summary, manager_confirmed, created_at)
    VALUES (@caseId, @caseCategory, @claimValue, @consumerStance, @retailerStance, @caseSummary, 0, @createdAt)
  `);
  const insertConsent = database.prepare(
    'INSERT INTO consents (case_id, role, granted) VALUES (?, ?, 0)'
  );
  const insertMessage = database.prepare(
    'INSERT INTO messages (case_id, author_role, text, created_at) VALUES (?, ?, ?, ?)'
  );

  const seed = database.transaction(() => {
    insertCase.run({ ...SEED_CASE, createdAt });
    for (const role of ['consumer', 'retailer']) insertConsent.run(caseId, role);
    insertMessage.run(caseId, 'system', SEED_CASE.caseSummary, createdAt);
    appendAudit(database, {
      caseId,
      actorRole: 'system',
      eventType: 'case_opened',
      payload: { claimValue: SEED_CASE.claimValue, caseCategory: SEED_CASE.caseCategory },
    });
    appendAudit(database, {
      caseId,
      actorRole: 'system',
      eventType: 'evidence_shared',
      payload: { summary: SEED_CASE.caseSummary },
    });
  });
  seed();

  return database.prepare('SELECT * FROM cases WHERE case_id = ?').get(caseId);
}

export function getLatestEventPayload(database, caseId, eventType) {
  const row = database
    .prepare('SELECT payload FROM audit_log WHERE case_id = ? AND event_type = ? ORDER BY id DESC LIMIT 1')
    .get(caseId, eventType);
  return row ? JSON.parse(row.payload) : null;
}

export function getConsentsMap(database, caseId) {
  const rows = database.prepare('SELECT role, granted FROM consents WHERE case_id = ?').all(caseId);
  const consents = { consumer: false, retailer: false };
  for (const row of rows) consents[row.role] = Boolean(row.granted);
  return consents;
}

export function loadCaseState(database, caseId) {
  const caseRow = database.prepare('SELECT * FROM cases WHERE case_id = ?').get(caseId);
  if (!caseRow) return null;

  const consents = getConsentsMap(database, caseId);
  const managerConfirmed = Boolean(caseRow.manager_confirmed);
  const status = computeStatus({
    consumerConsent: consents.consumer,
    retailerConsent: consents.retailer,
    managerConfirmed,
  });

  const messages = database
    .prepare('SELECT id, author_role AS authorRole, text, created_at AS createdAt FROM messages WHERE case_id = ? ORDER BY id ASC')
    .all(caseId);

  const auditTrail = database
    .prepare('SELECT id, actor_role AS actorRole, event_type AS eventType, payload, created_at AS createdAt, hash FROM audit_log WHERE case_id = ? ORDER BY id ASC')
    .all(caseId)
    .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));

  return {
    caseId: caseRow.case_id,
    caseCategory: caseRow.case_category,
    claimValue: caseRow.claim_value,
    consumerStance: caseRow.consumer_stance,
    retailerStance: caseRow.retailer_stance,
    status,
    consents: { ...consents, managerConfirmed },
    messages,
    auditTrail,
    auditChainVerified: verifyAuditChain(database, caseId),
    recommendation: getLatestEventPayload(database, caseId, 'recommendation_generated'),
    fulfillment: status === STATUS.AGREED ? getLatestEventPayload(database, caseId, 'fulfillment_logged') : null,
  };
}
