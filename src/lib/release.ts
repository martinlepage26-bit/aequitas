/**
 * The commit the running process was built from.
 *
 * Order (first non-blank wins):
 * 1. RAILWAY_GIT_COMMIT_SHA: set by Railway on every deployment it builds
 *    from GitHub, so it always names the build serving traffic there.
 * 2. RELEASE_SHA: set by the deploy script on non-Railway hosts (CT920) from
 *    `git rev-parse HEAD` at build time (deploy/ct920/deploy.sh). Never typed
 *    by hand.
 * 3. RELEASE_COMMIT: legacy fallback for local runs and CI.
 * A hand-typed RELEASE_COMMIT must never mask the deployed commit: on Oct 6 a
 * static RELEASE_COMMIT kept /api/health reporting a stale build while a newer
 * one was running.
 */
export function runningCommit(env: Record<string, string | undefined> = process.env): string {
  for (const name of ["RAILWAY_GIT_COMMIT_SHA", "RELEASE_SHA", "RELEASE_COMMIT"] as const) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return "unknown";
}
