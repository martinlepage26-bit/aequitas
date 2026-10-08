import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock("../../src/lib/prisma", () => ({ prisma: { $queryRaw: mocks.queryRaw } }));
import { GET } from "../../src/app/api/health/route";
import { runningCommit } from "../../src/lib/release";

// A fresh SHA per run: a release value typed into the code can never match it.
const sha = () => randomBytes(20).toString("hex");
const STALE = "9c772f16e6eef79c0952188e8c05df92bbb5249a";
const release = async () => {
  const response = await GET();
  expect(response.headers.get("cache-control")).toBe("no-store");
  return { status: response.status, body: await response.json() };
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  vi.stubEnv("RAILWAY_GIT_COMMIT_SHA", "");
  vi.stubEnv("RELEASE_COMMIT", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/health release", () => {
  it("reports the commit Railway deployed, read at request time", async () => {
    for (const deployed of [sha(), sha()]) {
      vi.stubEnv("RAILWAY_GIT_COMMIT_SHA", deployed);
      expect(await release()).toEqual({ status: 200, body: { status: "ok", release: deployed } });
    }
  });
  it("never lets a static RELEASE_COMMIT override the deployed commit", async () => {
    const deployed = sha();
    vi.stubEnv("RAILWAY_GIT_COMMIT_SHA", deployed);
    vi.stubEnv("RELEASE_COMMIT", STALE);
    expect((await release()).body.release).toBe(deployed);
  });
  it("falls back to RELEASE_COMMIT only when Railway provides no commit", async () => {
    const fallback = sha();
    vi.stubEnv("RELEASE_COMMIT", fallback);
    expect((await release()).body.release).toBe(fallback);
    vi.stubEnv("RAILWAY_GIT_COMMIT_SHA", "   ");
    expect((await release()).body.release).toBe(fallback);
  });
  it("says unknown instead of guessing", async () => {
    expect((await release()).body.release).toBe("unknown");
    expect(runningCommit({})).toBe("unknown");
  });
  it("hides the release when the database is unreachable", async () => {
    vi.stubEnv("RAILWAY_GIT_COMMIT_SHA", sha());
    mocks.queryRaw.mockRejectedValue(new Error("down"));
    expect(await release()).toEqual({ status: 503, body: { status: "unavailable" } });
  });
  it("keeps commit hashes out of the release source", () => {
    for (const file of ["src/lib/release.ts", "src/app/api/health/route.ts"]) {
      const code = readFileSync(path.resolve(import.meta.dirname, "../..", file), "utf8")
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/\b[0-9a-f]{7,40}\b/);
    }
  });
});
