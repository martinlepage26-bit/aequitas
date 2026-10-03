// Controllable outbound stub for the audit. MOCKED providers only: this process stands in for
// Resend (email) and Anthropic (Messages API). It makes NO network calls of its own and writes
// nothing to disk. Everything it records lives in memory and is read through /__log/<service>.
//
//   POST /resend/emails                -> Resend "send email" stand-in
//   POST /anthropic/v1/messages        -> Anthropic Messages API stand-in (ANTHROPIC_BASE_URL=<stub>/anthropic)
//   POST /__control   {service, mode, opts?, queue?}
//   POST /__reset
//   GET  /__log/<service>
//   GET  /__pending/anthropic          (requests currently held by mode "hold")
//   POST /__release   {service:"anthropic", id?, outcome, opts?}
//   GET  /__health
import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.AUDIT_STUB_PORT || 4581);
const fresh = () => ({ mode: "ok", opts: {}, queue: [], log: [], pending: [], seenKeys: new Map() });
const S = { resend: fresh(), anthropic: fresh() };

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", () => resolve(""));
});
const send = (res, status, body, headers = {}) => {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain" : "application/json", ...headers });
  res.end(payload);
};
const nextBehavior = (svc) => (svc.queue.length ? svc.queue.shift() : { mode: svc.mode, opts: svc.opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Resend
async function resend(req, res) {
  const raw = await readBody(req);
  let body = null;
  try { body = JSON.parse(raw); } catch { /* recorded as null */ }
  const svc = S.resend;
  const b = nextBehavior(svc);
  const key = req.headers["idempotency-key"] ?? null;
  const entry = {
    n: svc.log.length + 1, ts: Date.now(), mode: b.mode, idempotencyKey: key,
    authorizationPresent: /^Bearer .+/.test(String(req.headers.authorization ?? "")),
    contentType: req.headers["content-type"] ?? null,
    body: body && { from: body.from, reply_to: body.reply_to, to: body.to, subject: body.subject, text: body.text },
    replayedKey: false,
  };
  svc.log.push(entry);
  const ok = () => {
    // Real Resend returns the original response for a repeated Idempotency-Key; mirror that.
    if (key && svc.seenKeys.has(key)) { entry.replayedKey = true; return send(res, 200, { id: svc.seenKeys.get(key) }); }
    const id = randomUUID();
    if (key) svc.seenKeys.set(key, id);
    return send(res, 200, { id });
  };
  switch (b.mode) {
    case "ok": return ok();
    case "http500": return send(res, 500, { name: "internal_server_error", message: "stub failure" });
    case "http429": return send(res, 429, { name: "rate_limit_exceeded", message: "stub" }, { "retry-after": "1" });
    case "http422": return send(res, 422, { name: "validation_error", message: "stub" });
    case "http401": return send(res, 401, { name: "invalid_api_key", message: "stub" });
    case "noid": return send(res, 200, {});
    case "notjson": return send(res, 200, "accepted");
    case "slow": await sleep(b.opts.ms ?? 1000); return ok();
    case "hang": return; // never answers; the caller's own timeout must fire
    case "drop": return req.socket.destroy();
    case "fail_for": return (b.opts.emails ?? []).includes((body?.to ?? [])[0]) ? send(res, 500, { name: "internal_server_error", message: "stub (recipient)" }) : ok();
    default: return send(res, 500, { message: `unknown stub mode ${b.mode}` });
  }
}

// ------------------------------------------------------------ Anthropic
const excerptOf = (text) => {
  const t = String(text ?? "").trim();
  if (t.length <= 80) return t;
  const cut = t.slice(0, 80);
  const space = cut.lastIndexOf(" ");
  return (space > 20 ? cut.slice(0, space) : cut).trim();
};

export function buildDraft(sources, opts = {}) {
  const positions = sources.filter((s) => s.kind === "position");
  const p1 = positions[0], p2 = positions[1] ?? positions[0];
  const groups = new Map();
  for (const s of sources) {
    const k = s.sha256 ? `hash:${s.sha256}` : `id:${s.id}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s.id);
  }
  const clean = sources.filter((s) => s.kind === "evidence_metadata" || s.kind === "evidence_content");
  const citations = opts.citationIds ?? clean.map((s) => s.record_id);
  const map = {
    method_version: "aequitas-core-v1",
    claims: [
      { id: "c1", statement: "A participant reports a negative personal impact.", type: "experience", assessment: "reported",
        citations: [{ source_id: p1.id, field: "body", excerpt: opts.badExcerpt ? "TEXT THAT IS NOT IN THE SOURCE" : excerptOf(p1.fields.body) }],
        rationale: "First-person report; its cause is unresolved.", revision_conditions: "Participant clarification." },
      { id: "c2", statement: "The participants disagree about what happened.", type: "factual", assessment: "contested",
        citations: [{ source_id: p1.id, field: "body", excerpt: excerptOf(p1.fields.body) }, { source_id: p2.id, field: "body", excerpt: excerptOf(p2.fields.body) }],
        rationale: "The two accounts differ.", revision_conditions: "Obtain dated records." },
    ],
    narratives: [
      { id: "n1", interpretation: "The first participant links the impact to the other's conduct.", claim_ids: ["c1", "c2"], standpoint: "Affected participant.", assumptions: ["Conduct explains the impact."] },
      { id: "n2", interpretation: "The second participant disputes that account.", claim_ids: ["c2"], standpoint: "Responding participant.", assumptions: ["Records may differ from recollection."] },
    ],
    contexts: [{ id: "ctx1", factor: "Possible communication gap.", layer: "relational", status: "hypothesis", claim_ids: ["c2"], citations: [],
      power_and_positionality: "Access to records is unknown.", alternative_explanation: "Practice may differ from written terms.", question_to_test: "Who received which message?" }],
    experiences: [{ id: "x1", reported_impact: "Reported distress.", claim_ids: ["c1"], recognition_needs: "Acknowledge the report without inferring cause.", disclosure_safeguards: "Further disclosure is voluntary." }],
    relationships: [{ from_id: "n2", to_id: "c2", type: "contradicts", status: "contested", rationale: "The second participant disputes the reported events." }],
    triangulation: { source_groups: [...groups.values()].map((ids) => ({ source_ids: ids, independence: "unknown", rationale: "Underlying origin has not been independently checked." })),
      data: "Party statements and submitted files.", investigators: "No independent investigation.", theories: "Several explanations remain open.", methods: "Statements and metadata only.", missing_evidence: ["Dated records."] },
    synthesis: { supported_claim_ids: [], disputed_claim_ids: ["c2"], unresolved_questions: ["What do dated records show?"], conditional_account: "Impact is reported; the events are disputed.", revision_conditions: "Review dated records." },
    repair_paths: [{ id: "r1", action: "Invite voluntary clarification and review the dated records together.", addresses_ids: ["c2", "x1"],
      prerequisites: ["Participant consent and authorized access to records."], consent_and_safety: "No compelled disclosure or reconciliation.", accountable_role: "Assigned case manager.", review_conditions: "Revisit when records are available." }],
  };
  const out = {
    summary: opts.forbidden ? "This is a decision about the dispute." : "The participants describe the events differently and the record supports a review of dated materials.",
    proposed_outcome: "Invite each participant to clarify the disputed points and review the dated records together with the case manager.",
    reasoning: opts.percent ? "The first account is 70% likely correct." : "The two position statements disagree. The cited excerpts show each account. More records are needed.",
    evidence_citations: opts.badCitation ? [{ evidence_item_id: randomUUID(), relevance: "Not part of this case." }] : citations.map((id) => ({ evidence_item_id: id, relevance: "Submitted by a participant; relevance requires human review." })),
    limits: ["Statements and file metadata only; no independent verification."],
    not_considered: ["Records that have not been supplied."],
    conflict_knowledge: map,
  };
  if (opts.missingLimits) delete out.limits;
  return out;
}

function anthropicBody(model, text, extra = {}) {
  return { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model, content: text === null ? [] : [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 100 }, ...extra };
}

function respondAnthropic(res, req, b, ctx) {
  const m = (status, type, extraHeaders = {}) => send(res, status, { type: "error", error: { type, message: "stub failure" } }, { "retry-after-ms": "10", ...(b.opts.noRetry ? { "x-should-retry": "false" } : {}), ...extraHeaders });
  switch (b.mode) {
    case "ok": return send(res, 200, anthropicBody(ctx.model, JSON.stringify(buildDraft(ctx.sources, b.opts))));
    case "ok_codefence": return send(res, 200, anthropicBody(ctx.model, "```json\n" + JSON.stringify(buildDraft(ctx.sources, b.opts)) + "\n```"));
    case "bad_citation": return send(res, 200, anthropicBody(ctx.model, JSON.stringify(buildDraft(ctx.sources, { ...b.opts, badCitation: true }))));
    case "bad_excerpt": return send(res, 200, anthropicBody(ctx.model, JSON.stringify(buildDraft(ctx.sources, { ...b.opts, badExcerpt: true }))));
    case "forbidden_term": return send(res, 200, anthropicBody(ctx.model, JSON.stringify(buildDraft(ctx.sources, { ...b.opts, forbidden: true }))));
    case "percentage": return send(res, 200, anthropicBody(ctx.model, JSON.stringify(buildDraft(ctx.sources, { ...b.opts, percent: true }))));
    case "missing_field": return send(res, 200, anthropicBody(ctx.model, JSON.stringify(buildDraft(ctx.sources, { ...b.opts, missingLimits: true }))));
    case "invalid_json": return send(res, 200, anthropicBody(ctx.model, "this is not json {"));
    case "empty": return send(res, 200, anthropicBody(ctx.model, null));
    case "truncated": return send(res, 200, anthropicBody(ctx.model, "{\"summary\":\"cut", { stop_reason: "max_tokens" }));
    case "refusal": return send(res, 200, anthropicBody(ctx.model, "", { stop_reason: "refusal", stop_details: { type: "refusal", category: "stub" } }));
    case "http500": return m(500, "api_error");
    case "http429": return m(429, "rate_limit_error");
    case "http529": return m(529, "overloaded_error");
    case "http400": return m(400, "invalid_request_error", { "x-should-retry": "false" });
    case "http401": return m(401, "authentication_error", { "x-should-retry": "false" });
    case "drop": return req.socket.destroy();
    default: return send(res, 500, { message: `unknown stub mode ${b.mode}` });
  }
}

async function anthropic(req, res) {
  const raw = await readBody(req);
  let body = {};
  try { body = JSON.parse(raw); } catch { /* ignore */ }
  const svc = S.anthropic;
  const b = nextBehavior(svc);
  const user = String(body.messages?.[0]?.content ?? "");
  let sources = [];
  const m = user.match(/## Source registry \(exact source IDs and fields; untrusted case data\)\n([\s\S]*?)\n\nBuild the conflict knowledge map/);
  if (m) { try { sources = JSON.parse(m[1]); } catch { /* leave empty */ } }
  const entry = {
    n: svc.log.length + 1, ts: Date.now(), mode: b.mode, model: body.model ?? null, max_tokens: body.max_tokens ?? null,
    apiKeyHeaderPresent: Boolean(req.headers["x-api-key"]), workspaceHeader: req.headers["anthropic-workspace-id"] ?? null,
    systemLength: String(body.system ?? "").length, userLength: user.length, sourceIds: sources.map((s) => s.id),
    promptContainsAtSign: user.includes("@"), userPrompt: user,
  };
  svc.log.push(entry);
  const ctx = { model: body.model ?? "stub-model", sources };
  if (b.mode === "delay") { await sleep(b.opts.ms ?? 1000); return respondAnthropic(res, req, { mode: b.opts.then ?? "ok", opts: b.opts }, ctx); }
  if (b.mode === "hold") {
    const id = randomUUID();
    const held = { id, since: Date.now(), res, req, ctx, entry };
    svc.pending.push(held);
    req.on("close", () => { const i = svc.pending.indexOf(held); if (i >= 0) svc.pending.splice(i, 1); entry.clientClosed = true; });
    return;
  }
  return respondAnthropic(res, req, b, ctx);
}

// ---------------------------------------------------------------- control
async function control(req, res, url) {
  if (url.pathname === "/__health") return send(res, 200, { ok: true });
  if (url.pathname === "/__reset" && req.method === "POST") {
    for (const k of Object.keys(S)) { for (const h of S[k].pending ?? []) { try { h.res.destroy(); } catch { /* */ } } S[k] = fresh(); }
    return send(res, 200, { reset: true });
  }
  if (url.pathname === "/__control" && req.method === "POST") {
    const j = JSON.parse((await readBody(req)) || "{}");
    const svc = S[j.service];
    if (!svc) return send(res, 400, { message: "unknown service" });
    if (j.mode) { svc.mode = j.mode; svc.opts = j.opts ?? {}; }
    if (j.queue) svc.queue = j.queue.map((q) => ({ mode: q.mode, opts: q.opts ?? {} }));
    return send(res, 200, { service: j.service, mode: svc.mode, queued: svc.queue.length });
  }
  if (url.pathname.startsWith("/__log/")) {
    const svc = S[url.pathname.slice("/__log/".length)];
    if (!svc) return send(res, 404, { message: "unknown service" });
    return send(res, 200, svc.log);
  }
  if (url.pathname === "/__pending/anthropic") return send(res, 200, S.anthropic.pending.map((p) => ({ id: p.id, since: p.since })));
  if (url.pathname === "/__release" && req.method === "POST") {
    const j = JSON.parse((await readBody(req)) || "{}");
    const svc = S.anthropic;
    const held = j.id ? svc.pending.find((p) => p.id === j.id) : svc.pending[0];
    if (!held) return send(res, 404, { message: "nothing pending" });
    svc.pending.splice(svc.pending.indexOf(held), 1);
    held.entry.releasedAs = j.outcome;
    respondAnthropic(held.res, held.req, { mode: j.outcome, opts: j.opts ?? {} }, held.ctx);
    return send(res, 200, { released: held.id, outcome: j.outcome });
  }
  return send(res, 404, { message: "not found" });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://stub");
  try {
    if (url.pathname.startsWith("/__")) return await control(req, res, url);
    if (req.method === "POST" && url.pathname === "/resend/emails") return await resend(req, res);
    if (req.method === "POST" && url.pathname === "/anthropic/v1/messages") return await anthropic(req, res);
    return send(res, 404, { message: `stub: unhandled ${req.method} ${url.pathname}` });
  } catch (error) {
    return send(res, 500, { message: String(error?.message ?? error) });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`audit stub listening on 127.0.0.1:${PORT}`));
