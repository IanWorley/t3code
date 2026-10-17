#!/usr/bin/env bash
# Stop the dev stack that start.sh launched, by its recorded process group only.
# Usage: stop.sh     Archives the dev log into the evidence dir; never deletes evidence or .t3 state.
set -euo pipefail

GRACE_SECONDS=10

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
RUN_DIR="$REPO_ROOT/.t3/verify/run"
EVIDENCE_DIR="$REPO_ROOT/.t3/verify/evidence"
PGID_FILE="$RUN_DIR/dev.pgid"

if [[ ! -f "$PGID_FILE" ]]; then
  echo "Nothing to stop: no $PGID_FILE (start.sh did not launch a stack here)."
  exit 0
fi
pgid="$(cat "$PGID_FILE")"

if kill -0 -- "-$pgid" 2>/dev/null; then
  kill -TERM -- "-$pgid"
  deadline=$((SECONDS + GRACE_SECONDS))
  while kill -0 -- "-$pgid" 2>/dev/null && (( SECONDS < deadline )); do sleep 1; done
  if kill -0 -- "-$pgid" 2>/dev/null; then
    echo "Process group $pgid ignored SIGTERM for ${GRACE_SECONDS}s; sending SIGKILL."
    kill -KILL -- "-$pgid" 2>/dev/null || true
  fi
fi

mkdir -p "$EVIDENCE_DIR"
if [[ -f "$RUN_DIR/dev.log" ]]; then
  archived="$EVIDENCE_DIR/dev-$(date +%Y%m%d-%H%M%S).log"
  mv "$RUN_DIR/dev.log" "$archived"
  echo "Dev log archived to $archived"
fi
rm -f "$PGID_FILE"
rmdir "$RUN_DIR" 2>/dev/null || true
echo "Stopped process group $pgid. Evidence kept in $EVIDENCE_DIR"
