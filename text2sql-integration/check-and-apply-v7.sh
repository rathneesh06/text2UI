#!/usr/bin/env bash
# check-and-apply-v3.sh — run from your text2UI repo root.
#   ./check-and-apply-v3.sh          -> diagnose only: prints which integration version this repo has
#   ./check-and-apply-v3.sh apply    -> diagnose, then copy the v3 files in (from ./paste-these), then verify
#
# Version fingerprints:
#   v0  no workbench at all
#   v1  /workbench exists, MySQL-only (no bff/sources/db-conn.ts)
#   v2  db-conn.ts exists (Postgres dialect) but no /postgres page
#   v3  /postgres route + pgOnly form + safeDecode + connFromParts
#   v4  string-first /postgres page (normalizePgString) + manual-fields toggle
#   v5  fail-fast TCP preflight with network-specific errors (preflightTcp)  <- target
set -u
echo "check-and-apply v7 (rev c — script-dir aware). If you don't see this banner, you are running a different script."

# Run from anywhere: paste-these is resolved NEXT TO THIS SCRIPT, while the
# fingerprint checks require the CWD to be the repo root.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f package.json ] || [ ! -d bff ] || [ ! -d src ]; then
  echo "ERROR: run this from your text2UI repo root (found no package.json/bff/src here)"; exit 1
fi

have() { [ -e "$1" ] && echo 1 || echo 0; }
has() { grep -qs "$2" "$1" && echo 1 || echo 0; }

WB=$(have src/pages/WorkbenchPage.tsx)
DC=$(have bff/sources/db-conn.ts)
PGROUTE=$(has src/App.tsx '"/postgres"')
PGONLY=$(has src/pages/WorkbenchPage.tsx 'pgOnly')
SD=$(has bff/sources/db-conn.ts 'safeDecode')
CFP=$(has bff/sources/db-conn.ts 'connFromParts')
PARTS=$(has bff/text2sql/handler.ts 'b.parts')
WCP=$(has src/workbench-api.ts 'wbConnectParts')
V4=$(has src/pages/WorkbenchPage.tsx 'normalizePgString')
V5A=$(has bff/sources/connection-registry.ts 'preflightTcp')
V5B=$(has bff/sources/workbench-store.ts 'finalizeStaged')
V5C=$(has src/pages/WorkbenchPage.tsx 'wb-staged')
V5=$([ "$V5A$V5B$V5C" = 111 ] && echo 1 || echo 0)
V6A=$(has bff/sources/workbench-store.ts 'saveStages')
V6B=$(has bff/text2sql/planner.ts 'rankTables')
V6C=$(has src/workbench-api.ts 'wbDeleteSource')
V6=$([ "$V6A$V6B$V6C" = 111 ] && echo 1 || echo 0)
V7A=$(has bff/orchestrator.ts 'gateTurn')
V7B=$(has bff/dashboard/handler.ts 'summarizeSpecChange')
V7C=$(has shared/dashboard-spec.ts 'chartPalette')
V7D=$(has bff/text2sql/handler.ts 'handleSourceChat')
# Frontend markers too: a v7 BFF with a stale ChatPage returns respond-shaped
# plans the old client can't handle ("mode is undefined" crash) — that state
# must fingerprint as PARTIAL, not v7.
V7E=$(has src/pages/ChatPage.tsx 'answerInstead')
V7F=$(has src/api.ts '/api/gate')
V7=$([ "$V7A$V7B$V7C$V7D$V7E$V7F" = 111111 ] && echo 1 || echo 0)

echo "workbench page:            $WB"
echo "db-conn.ts (v2+):          $DC"
echo "safeDecode (v3 %40 fix):   $SD"
echo "connFromParts (v3):        $CFP"
echo "handler accepts parts:     $PARTS"
echo "wbConnectParts client:     $WCP"
echo "pgOnly form in Workbench:  $PGONLY"
echo "/postgres route in App:    $PGROUTE"
echo "string-first PG page (v4): $V4"
echo "TCP preflight (v5):        $V5"

if   [ "$WB" = 0 ]; then VER=v0
elif [ "$DC" = 0 ]; then VER=v1
elif [ "$PGROUTE" = 0 ] || [ "$PGONLY" = 0 ]; then VER=v2
elif [ "$V4" = 0 ]; then VER=v3
elif [ "$V5" = 0 ]; then VER=v4
elif [ "$V6" = 0 ]; then VER=v5
elif [ "$V7" = 0 ]; then VER=v6
elif [ "$SD$CFP$PARTS$WCP$V4$V5$V6$V7" = 11111111 ]; then VER=v7
else VER="partial (mixed files — apply v7 to normalize)"
fi
echo
echo ">>> This repo is at integration version: $VER"
[ "${1:-}" != "apply" ] && { echo "(run with 'apply' and ./paste-these present to bring it to v7)"; exit 0; }

[ -d "$SCRIPT_DIR/paste-these" ] || { echo "ERROR: paste-these not found next to this script ($SCRIPT_DIR/paste-these)"; exit 1; }
echo
echo ">>> Applying v7 from ./paste-these …"
# paste-these contains FULL file versions (new files + fully-patched modified
# files based on the 2026-07-03 backup). If you've hand-edited any of these six
# files since the backup, review the diff below before committing.
FILES=$(cd "$SCRIPT_DIR/paste-these" && find . -type f | sed 's|^\./||')
for f in $FILES; do
  mkdir -p "$(dirname "$f")"
  if [ -f "$f" ] && ! cmp -s "$SCRIPT_DIR/paste-these/$f" "$f"; then echo "  overwrite: $f"; else echo "  add:       $f"; fi
  cp "$SCRIPT_DIR/paste-these/$f" "$f"
done

# package.json is NOT in paste-these (it's yours to merge): add the test scripts.
node - <<'EOF'
const fs = require("fs");
const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
p.scripts["test:t2sql-guard"]   ??= "tsx bff/text2sql/guard.test.ts";
p.scripts["test:t2sql-planner"] ??= "tsx bff/text2sql/planner.test.ts";
p.scripts["test:db-conn"]       ??= "tsx bff/sources/db-conn.test.ts";
fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
console.log("  merged:    package.json test scripts");
EOF

echo
echo ">>> Verifying …"
npm run typecheck && npm run test:t2sql-guard && npm run test:t2sql-planner && npm run test:db-conn && npm run build \
  && echo && echo ">>> v7 applied and verified. Restart dev servers (dev:bff + dev), hard-refresh the browser, then open /postgres." \
  || { echo; echo ">>> Verification FAILED — see the first error above (likely local drift in one of the six modified files; diff it against paste-these/)."; exit 1; }
