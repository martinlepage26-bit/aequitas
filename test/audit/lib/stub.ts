import { cfg } from "./config";

/** Control client for the MOCKED provider stub (audit/backend-e2e-20261003/harness/stub.mjs). */
async function call(path: string, body?: unknown) {
  const res = await fetch(cfg.stub + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", connection: "close" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.json();
}
export type Service = "resend" | "anthropic";
export const stub = {
  reset: () => call("/__reset", {}),
  control: (service: Service, mode: string, opts: Record<string, unknown> = {}) => call("/__control", { service, mode, opts }),
  queue: (service: Service, queue: Array<{ mode: string; opts?: Record<string, unknown> }>) => call("/__control", { service, queue }),
  log: (service: Service) => call(`/__log/${service}`) as Promise<Array<Record<string, any>>>,
  pending: () => call("/__pending/anthropic") as Promise<Array<{ id: string; since: number }>>,
  release: (outcome: string, opts: Record<string, unknown> = {}, id?: string) => call("/__release", { service: "anthropic", outcome, opts, id }),
};
