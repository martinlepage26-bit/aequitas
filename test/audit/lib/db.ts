import pg from "pg";
import { cfg } from "./config";

// timestamp(3) columns carry no zone; read them as UTC so ISO strings match what the app hashed.
pg.types.setTypeParser(1114, (value: string) => new Date(`${value.replace(" ", "T")}Z`));

export const pool = new pg.Pool({ connectionString: cfg.dbUrl, max: 10 });
export async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, params)).rows as T[];
}
export async function one<T = any>(sql: string, params: unknown[] = []): Promise<T | undefined> { return (await q<T>(sql, params))[0]; }
export async function closePool() { await pool.end(); }

/** Verify the audit database target before any write that is not an application request (the data-directory check lives in with-db.sh, which runs as the cluster admin). */
export async function assertAuditDatabase() {
  const row = await one<{ db: string; port: number; role: string }>(`select current_database() as db, inet_server_port() as port, current_user as role`);
  if (!row || (row.db !== "aequitas_audit_test" && row.db !== "aequitas_audit_tamper_test") || row.port !== 54329 || row.role !== "aq_test") {
    throw new Error(`Refusing to proceed: unexpected database target ${JSON.stringify(row)}`);
  }
  return row;
}

/**
 * Holds a row lock on a case in a separate session. Requests issued meanwhile pass their application-level
 * pre-checks (plain reads are not blocked) and then queue on their first write, so releasing the lock makes
 * them run their write transactions together. Deterministic way to expose check-then-act races.
 */
export async function holdCaseLock(caseId: string) {
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query(`SELECT id FROM "Case" WHERE id = $1 FOR UPDATE`, [caseId]);
  let released = false;
  return {
    async release() { if (released) return; released = true; try { await client.query("COMMIT"); } finally { client.release(); } },
  };
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 15_000, intervalMs = 100): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value as T;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const caseEvents = (caseId: string) => q<{ id: string; seq: number; type: string; actorId: string; payload: any; prevHash: string; hash: string; createdAt: Date }>(
  `select * from "Event" where "caseId"=$1 order by seq asc`, [caseId]);
export const caseRow = (caseId: string) => one<Record<string, any>>(`select * from "Case" where id=$1`, [caseId]);
export const eventTypes = async (caseId: string) => (await caseEvents(caseId)).map((e) => e.type);
