#!/bin/bash
cd "$(dirname "$0")/.."

# Load env vars: canonical location first, then project .env (project overrides)
set -a
# shellcheck disable=SC1091
source "$HOME/.claude/teams-bot/.env" 2>/dev/null
# shellcheck disable=SC1091
source .env 2>/dev/null
set +a

if [ -z "$DEVTUNNEL_ID" ]; then
  echo "[run.sh] ERROR: DEVTUNNEL_ID is not set in .env"
  echo ""
  echo "  Create a persistent tunnel:"
  echo "  1. devtunnel create --id <your-tunnel-name> --allow-anonymous"
  echo "  2. devtunnel port create <your-tunnel-name> -p 3978"
  echo "  3. Set DEVTUNNEL_ID in .env to the tunnel ID"
  exit 1
fi

TUNNEL_ID="$DEVTUNNEL_ID"
MAX_TUNNEL_RESTARTS="${TUNNEL_MAX_RESTARTS:-5}"
TUNNEL_RESTART_DELAY_SEC="${TUNNEL_RESTART_DELAY_SEC:-2}"
TUNNEL_RESTART_COUNT=0
RUNNING=1
TUNNEL_LOG=""
TUNNEL_PID=""

# Ensure devtunnel is findable (WinGet installs to a path not always in bash PATH)
if ! command -v devtunnel &>/dev/null; then
  export PATH="$PATH:/c/Users/$USER/AppData/Local/Microsoft/WinGet/Links"
fi

cleanup() {
  RUNNING=0
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
    echo "[run.sh] Tunnel auth expired or permissions lost."
    echo ""
    echo "  Fix steps:"
    echo "  1. devtunnel user logout && devtunnel user login"
    echo "  2. Try again: teams-bot restart"
  fi
  rm -f "$TUNNEL_LOG"
  cleanup
fi

[ -n "$TUNNEL_LOG" ] && rm -f "$TUNNEL_LOG"
TUNNEL_LOG=""

echo "[run.sh] Bot PID=$BOT_PID, Tunnel PID=$TUNNEL_PID"

# Wait and recover tunnel on transient exits
while [ "$RUNNING" -eq 1 ] && kill -0 "$BOT_PID" 2>/dev/null; do
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    if [ -n "$TUNNEL_LOG" ] && grep -qi "Unauthorized" "$TUNNEL_LOG"; then
      echo "[run.sh] Tunnel auth expired or permissions lost."
      cat "$TUNNEL_LOG"
      cleanup
    fi

    TUNNEL_RESTART_COUNT=$((TUNNEL_RESTART_COUNT + 1))
    if [ "$TUNNEL_RESTART_COUNT" -gt "$MAX_TUNNEL_RESTARTS" ]; then
      echo "[run.sh] Tunnel exited too many times ($TUNNEL_RESTART_COUNT)."
      [ -n "$TUNNEL_LOG" ] && cat "$TUNNEL_LOG"
      cleanup
    fi

    echo "[run.sh] Tunnel exited. Restarting (${TUNNEL_RESTART_COUNT}/${MAX_TUNNEL_RESTARTS})..."
    [ -n "$TUNNEL_LOG" ] && cat "$TUNNEL_LOG"
    [ -n "$TUNNEL_LOG" ] && rm -f "$TUNNEL_LOG"
    TUNNEL_LOG=""
    sleep "$TUNNEL_RESTART_DELAY_SEC"
    if ! start_tunnel; then
      echo "[run.sh] Tunnel restart failed."
    fi
    continue
  fi

  sleep 1
done

echo "[run.sh] Bot process exited, cleaning up..."
cleanup
