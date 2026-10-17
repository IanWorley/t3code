#!/usr/bin/env bash
# Read-only check: is the running server this worktree's isolated instance, and is it healthy?
# Usage: doctor.sh        Exit 0 = safe to drive; non-zero = do not drive, read the message.
set -uo pipefail

PROBE_TIMEOUT_SECONDS=5
DESCRIPTOR_PATH="/.well-known/t3/environment"

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
USERDATA="$REPO_ROOT/.t3/userdata"
RUNTIME_FILE="$USERDATA/server-runtime.json"
ENV_ID_FILE="$USERDATA/environment-id"
PGID_FILE="$REPO_ROOT/.t3/verify/run/dev.pgid"

fail() { echo "FAIL: $*"; exit 1; }
json_field() { node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8"))[process.argv[1]];if(v!==undefined)console.log(v)' "$1"; }

[[ -f "$RUNTIME_FILE" ]] || fail "no $RUNTIME_FILE: no server is running for this worktree. Run start.sh."
runtime="$(cat "$RUNTIME_FILE")"
pid="$(json_field pid <<<"$runtime")"
origin="$(json_field origin <<<"$runtime")"
dev_url="$(json_field devUrl <<<"$runtime")"

kill -0 "$pid" 2>/dev/null || fail "server pid $pid from server-runtime.json is not running (stale file). Run start.sh."
pid_cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
[[ "$pid_cwd" == "$REPO_ROOT"* ]] || fail "server pid $pid runs in '$pid_cwd', not this worktree. Do not drive it."

descriptor="$(curl -fsS -m "$PROBE_TIMEOUT_SECONDS" "$origin$DESCRIPTOR_PATH")" || fail "server at $origin did not answer $DESCRIPTOR_PATH"
served_env_id="$(json_field environmentId <<<"$descriptor")"
[[ "$served_env_id" == "$(cat "$ENV_ID_FILE")" ]] || fail "server reports environment $served_env_id, but this worktree's is $(cat "$ENV_ID_FILE"). Wrong instance."

if [[ -n "$dev_url" ]]; then
  curl -fsS -o /dev/null -m "$PROBE_TIMEOUT_SECONDS" "${dev_url%/}$DESCRIPTOR_PATH" || fail "web dev server $dev_url is not proxying to the server"
fi

if [[ -f "$PGID_FILE" ]] && kill -0 -- "-$(cat "$PGID_FILE")" 2>/dev/null; then
  owner="started by verify-t3code start.sh (pgid $(cat "$PGID_FILE"))"
else
  owner="NOT started by start.sh (someone else's session: reuse it, but do not stop it)"
fi

echo "OK: server pid=$pid origin=$origin web=${dev_url:-none} env=$served_env_id version=$(json_field serverVersion <<<"$descriptor")"
echo "    state=$USERDATA"
echo "    owner: $owner"
