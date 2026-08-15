#!/usr/bin/env bash
# Builds for Cloudflare Workers via OpenNext. Several things in this
# codebase cannot run on Workers at all (not just "too large"), or are
# dead weight OpenNext's dependency tracer over-includes; all staged out
# before the build (so esbuild never bundles them) and restored on exit.
#
# 1. src/proxy.ts — Next.js 16's Proxy defaults to the Node.js runtime, and
#    that config option can't be overridden in Proxy files (Next's own
#    docs: "Setting the runtime config option in Proxy will throw an
#    error"); @opennextjs/cloudflare rejects Node-runtime proxy outright.
#    Loss: unprefixed /cases/:id no longer auto-redirects to /fr-CA/... on
#    this deployment — every internal link already uses locale-prefixed
#    hrefs, so this only affects hand-typed/bookmarked bare URLs.
# 2. The M0-era legacy demo (src/app/page.js + its two remaining legacy API
#    routes + src/lib/db.js/workflow.js/ai.js/legalFramework.js) uses
#    better-sqlite3, a native Node addon Workers cannot execute at all.
# 3. src/lib/storage.ts's @aws-sdk/client-s3 fallback — dead weight once R2
#    (native binding) is the real runtime path.
# 4. src/lib/prisma.ts's bare `../generated/prisma` import — resolves to
#    BOTH index.js's and edge.js's WASM query-compiler chains rather than
#    just one (~14MB of duplicate 3.6MB WASM). The explicit /edge import
#    fixes this but breaks Vitest/Node (its loader expects a Workers-style
#    `import()` of a .wasm module), so it's CF-build-only too.
# 5. `prisma` (CLI, devDependency-only), `@prisma/dev` and `@electric-sql`
#    (Prisma's local-dev embedded-Postgres tooling — ~82MB, including a
#    full duplicated PGlite WASM Postgres), and `@prisma/{studio-core,
#    engines,query-plan-executor,fetch-engine,get-platform,streams-local}`
#    (native-engine/tooling packages the driver-adapter runtime path never
#    touches) — none imported by any real runtime code path (verified by
#    grepping the bundled output; the only apparent match was
#    @prisma/engines-version's tiny package.json being string-matched as a
#    substring, not a real reference).
# 6. @prisma/client's generic runtime/ ships base64-embedded WASM query
#    compilers for every provider (mysql/sqlite/sqlserver/cockroachdb) in
#    both fast/small variants and both .js/.mjs formats — this Postgres-only
#    app's own generated client only ever needs the postgresql one.
#
# This pruning MUST happen before the build, not after: esbuild inlines
# whatever it finds into a self-contained handler.mjs, so deleting files
# from a staging copy afterward does not shrink what was already bundled.
set -euo pipefail
cd "$(dirname "$0")/.."

STAGE=$(mktemp -d)
FILES=(
  "prisma.config.ts"
  "src/proxy.ts"
  "src/app/page.js"
  "src/app/api/cases/[caseId]/messages"
  "src/app/api/cases/[caseId]/recommendation"
  "src/components/NeutralArbiter.js"
  "src/components/LegriproCompliance.js"
  "src/lib/db.js"
  "src/lib/workflow.js"
  "src/lib/ai.js"
  "src/lib/legalFramework.js"
  "node_modules/prisma"
  "node_modules/@prisma/dev"
  "node_modules/@electric-sql"
  "node_modules/@prisma/studio-core"
  "node_modules/@prisma/engines"
  "node_modules/@prisma/query-plan-executor"
  "node_modules/@prisma/fetch-engine"
  "node_modules/@prisma/get-platform"
  "node_modules/@prisma/streams-local"
)

# @prisma/client/runtime's per-provider WASM files can't be moved as a
# whole directory (the package itself is needed) — collect just the
# non-postgresql query-compiler files individually.
WASM_RUNTIME_DIR="node_modules/@prisma/client/runtime"
if [ -d "$WASM_RUNTIME_DIR" ]; then
  while IFS= read -r -d '' f; do
    FILES+=("$f")
  done < <(find "$WASM_RUNTIME_DIR" -maxdepth 1 -type f \
    \( -name "query_compiler_*bg.mysql.*" -o -name "query_compiler_*bg.sqlite.*" \
       -o -name "query_compiler_*bg.sqlserver.*" -o -name "query_compiler_*bg.cockroachdb.*" \) \
    -print0)
fi

restore() {
  for f in "${FILES[@]}"; do
    base="$(basename "$f")"
    if [ -e "$STAGE/$base" ] && [ ! -e "$f" ]; then
      mv "$STAGE/$base" "$f"
    fi
  done
  if [ -e "$STAGE/storage.ts.orig" ]; then
    mv "$STAGE/storage.ts.orig" "src/lib/storage.ts"
  fi
  if [ -e "$STAGE/prisma.ts.orig" ]; then
    mv "$STAGE/prisma.ts.orig" "src/lib/prisma.ts"
  fi
  rm -rf "$STAGE"
}
trap restore EXIT

for f in "${FILES[@]}"; do
  if [ -e "$f" ]; then
    mv "$f" "$STAGE/$(basename "$f")"
  fi
done

# Swap in the R2-only storage module — no @aws-sdk/client-s3 import, which
# is otherwise dead weight on this deployment target (bundle size).
cp "src/lib/storage.ts" "$STAGE/storage.ts.orig"
cp "scripts/storage.cf.ts" "src/lib/storage.ts"

# Swap in the explicit /edge Prisma import — eliminates the WASM
# duplication described in point 4 above.
cp "src/lib/prisma.ts" "$STAGE/prisma.ts.orig"
cp "scripts/prisma.cf.ts" "src/lib/prisma.ts"

npx opennextjs-cloudflare build
if [ "${1:-}" = "deploy" ]; then
  npx opennextjs-cloudflare deploy
fi
