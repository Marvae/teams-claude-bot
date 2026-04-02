#!/bin/bash
# This script must be executed, not sourced.
cd "$(dirname "$0")/.."

# Re-exec as login shell to inherit user's full PATH (launchd/systemd provide minimal PATH)
if [ -z "$_RUN_SH_LOGIN" ]; then
  export _RUN_SH_LOGIN=1
  exec "${SHELL:-bash}" -l "$0" "$@"
fi

# Load env vars: canonical location first, then project .env (project overrides)
set -a
# shellcheck disable=SC1091
source "$HOME/.claude/teams-bot/.env" 2>/dev/null
# shellcheck disable=SC1091
source .env 2>/dev/null
set +a

if [ -z "$DEVTUNNEL_ID" ]; then
  echo "[run.sh] ERROR: DEVTUNNEL_ID is not set."
  echo ""
  echo "  Fix: teams-bot setup tunnel"
  exit 1
fi

TUNNEL_ID="$DEVTUNNEL_ID"
MAX_RESTARTS=5
RESTART_COUNT=0

# Ensure devtunnel is findable (WinGet installs to a path not always in bash PATH)
if ! command -v devtunnel &>/dev/null; then
  export PATH="$PATH:$HOME/AppData/Local/Microsoft/WinGet/Links"
fi

cleanup() {
  echo "[run.sh] Shutting down..."
  kill "$BOT_PID" "$TUNNEL_PID" 2>/dev/null
  wait "$BOT_PID" "$TUNNEL_PID" 2>/dev/null
  [ -n "$TUNNEL_LOG" ] && rm -f "$TUNNEL_LOG"
  echo "[run.sh] All processes stopped"
  exit 0
}

trap cleanup INT TERM EXIT

# Start bot
node dist/index.js &
BOT_PID=$!

start_tunnel() {
  [ -n "$TUNNEL_LOG" ] && rm -f "$TUNNEL_LOG"
  TUNNEL_LOG=$(mktemp)
  devtunnel host "$TUNNEL_ID" > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!
  sleep 3
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    return 1
  fi
  cat "$TUNNEL_LOG"
  return 0
}

if ! start_tunnel; then
  echo "[run.sh] ERROR: Tunnel failed to start!"
  echo ""
  cat "$TUNNEL_LOG"
  echo ""
  if grep -qi "Unauthorized" "$TUNNEL_LOG"; then
    echo "[run.sh] Tunnel auth expired."
    echo "  Fix: devtunnel user login && teams-bot restart"
  elif grep -qi "not found\|does not exist" "$TUNNEL_LOG"; then
    echo "[run.sh] Tunnel does not exist."
    echo "  Fix: teams-bot setup tunnel && teams-bot restart"
  else
    echo "  Fix: teams-bot setup tunnel && teams-bot restart"
  fi
  cleanup
fi

echo "[run.sh] Bot PID=$BOT_PID, Tunnel PID=$TUNNEL_PID"

# Main loop: restart tunnel on crash, up to MAX_RESTARTS times
while kill -0 "$BOT_PID" 2>/dev/null; do
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    RESTART_COUNT=$((RESTART_COUNT + 1))
    if [ "$RESTART_COUNT" -gt "$MAX_RESTARTS" ]; then
      echo "[run.sh] Tunnel crashed $RESTART_COUNT times, giving up."
      cleanup
    fi
    echo "[run.sh] Tunnel exited. Restart ${RESTART_COUNT}/${MAX_RESTARTS} in 5s..."
    sleep 5
    if ! start_tunnel; then
      echo "[run.sh] Tunnel restart failed."
      continue
    fi
    echo "[run.sh] Tunnel restarted."
  fi
  sleep 1
done

echo "[run.sh] Bot process exited, cleaning up..."
cleanup
