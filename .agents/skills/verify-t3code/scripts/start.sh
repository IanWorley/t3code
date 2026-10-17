#!/usr/bin/env bash
# Start this worktree's dev stack (server + web) for verification.
# Usage: start.sh [--share]   (--share is required when the Browser panel's client is remote)
# Prints the ports and the startup pairing URL once the server is ready.
set -euo pipefail

READY_TIMEOUT_SECONDS=240
POLL_INTERVAL_SECONDS=2
READY_MARKER="pairingUrl:"
PORT_MARKER="[dev-runner] mode="

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
RUN_DIR="$REPO_ROOT/.t3/verify/run"
LOG_FILE="$RUN_DIR/dev.log"
PGID_FILE="$RUN_DIR/dev.pgid"

if [[ -f "$PGID_FILE" ]] && kill -0 -- "-$(cat "$PGID_FILE")" 2>/dev/null; then
  echo "A verification dev stack is already running (pgid $(cat "$PGID_FILE")). Run doctor.sh or stop.sh." >&2
  exit 1
fi
if [[ ! -d "$REPO_ROOT/node_modules" ]]; then
  echo "node_modules missing: run 'vp i --frozen-lockfile -- --yes' in $REPO_ROOT first." >&2
  exit 1
fi

mkdir -p "$RUN_DIR"
: > "$LOG_FILE"

# Job control gives the background job its own process group, so stop.sh can
# end the whole vp -> dev-runner -> vite/server tree without matching names.
set -m
(cd "$REPO_ROOT" && exec vp run dev "$@" < /dev/null > "$LOG_FILE" 2>&1) &
echo "$!" > "$PGID_FILE"
set +m

deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
until grep -q "$READY_MARKER" "$LOG_FILE"; do
  if ! kill -0 -- "-$(cat "$PGID_FILE")" 2>/dev/null; then
    echo "Dev stack exited before becoming ready. Last log lines:" >&2
    tail -n 30 "$LOG_FILE" >&2
    exit 1
  fi
  if (( SECONDS >= deadline )); then
    echo "Timed out after ${READY_TIMEOUT_SECONDS}s waiting for '$READY_MARKER' in $LOG_FILE" >&2
    exit 1
  fi
  sleep "$POLL_INTERVAL_SECONDS"
done

grep -F "$PORT_MARKER" "$LOG_FILE" | tail -n 1
grep -F "shared on tailnet" "$LOG_FILE" | tail -n 1 || true
# The pairing URL is a one-time credential: hand it to exactly one browser.
grep -F "$READY_MARKER" "$LOG_FILE" | tail -n 1 | sed 's/^ *//'
echo "pgid=$(cat "$PGID_FILE") log=$LOG_FILE"
