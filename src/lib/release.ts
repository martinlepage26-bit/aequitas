/**
 * The commit the running process was built from.
 *
 * Railway sets RAILWAY_GIT_COMMIT_SHA on every deployment it builds from
 * GitHub, so it always names the build that is actually serving traffic.
 * RELEASE_COMMIT is only a fallback for hosts that do not provide it (local
 * runs, CI). A hand-typed RELEASE_COMMIT must never mask the deployed commit:
 * on Oct 6 a static RELEASE_COMMIT kept /api/health reporting 9c772f16 while
 * 937c217 was running.
 */
export function runningCommit(env: Record<string, string | undefined> = process.env): string {
  const deployed = env.RAILWAY_GIT_COMMIT_SHA?.trim();
  if (deployed) return deployed;
  const fallback = env.RELEASE_COMMIT?.trim();
  if (fallback) return fallback;
  return "unknown";
}
