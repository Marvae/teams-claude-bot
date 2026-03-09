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
MAX_TUNNEL_RESTARTS_TOTAL="${TUNNEL_MAX_RESTARTS_TOTAL:-15}"
TUNNEL_RESTART_COUNT=0
TUNNEL_RESTART_TOTAL=0
RUNNING=1
TUNNEL_LOG=""
TUNNEL_PID=""
LAST_TUNNEL_START=0
HEALTH_CHECK_INTERVAL=300  # 5 minutes
HEALTH_CHECK_FAIL_COUNT=0
LAST_HEALTH_CHECK=0

# Exponential backoff: 2, 4, 8, 16, 30 (capped)
get_restart_delay() {
  local count=$1
  local delay=$((2 ** (count + 1)))
  if [ "$delay" -gt 30 ]; then
    delay=30
  fi
  echo "$delay"
}

# Ensure devtunnel is findable (WinGet installs to a path not always in bash PATH)
if ! command -v devtunnel &>/dev/null; then
  export PATH="$PATH:/c/Users/$USER/AppData/Local/Microsoft/WinGet/Links"
fi

# Send health alert to Teams via bot's local endpoint.
# Outgoing messages bypass the tunnel (bot → Azure Bot Service → Teams).
# Only sends when running as a background service (HEALTH_ALERTS=1).
send_alert() {
  [ "${HEALTH_ALERTS:-}" != "1" ] && return
  local msg="$1"
  curl -sf --max-time 5 -X POST "http://127.0.0.1:${PORT:-3978}/api/health-alert" \
    -H "Content-Type: application/json" \
    -d "{\"message\": \"$msg\"}" > /dev/null 2>&1 || true
}

cleanup() {
  [ "$RUNNING" -eq 0 ] && return
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
  [ -n "$TUNNEL_LOG" ] && rm -f "$TUNNEL_LOG"
  TUNNEL_LOG=$(mktemp)
  devtunnel host "$TUNNEL_ID" > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!
  LAST_TUNNEL_START=$(date +%s)
  HEALTH_CHECK_FAIL_COUNT=0
  LAST_HEALTH_CHECK=$(date +%s)

  sleep 3
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    return 1
  fi

  cat "$TUNNEL_LOG"
  return 0
}

restart_tunnel() {
  local delay
  delay=$(get_restart_delay "$TUNNEL_RESTART_COUNT")
  TUNNEL_RESTART_COUNT=$((TUNNEL_RESTART_COUNT + 1))
  TUNNEL_RESTART_TOTAL=$((TUNNEL_RESTART_TOTAL + 1))
  if [ "$TUNNEL_RESTART_COUNT" -gt "$MAX_TUNNEL_RESTARTS" ]; then
    echo "[run.sh] Tunnel exited too many times ($TUNNEL_RESTART_COUNT consecutive)."
    [ -n "$TUNNEL_LOG" ] && tail -20 "$TUNNEL_LOG"
    send_alert "⚠️ Bot tunnel crashed $TUNNEL_RESTART_COUNT times and gave up. Run \`teams-bot restart\` to recover."
    cleanup
  fi
  if [ "$TUNNEL_RESTART_TOTAL" -gt "$MAX_TUNNEL_RESTARTS_TOTAL" ]; then
    echo "[run.sh] Tunnel total restarts exceeded limit ($TUNNEL_RESTART_TOTAL)."
    [ -n "$TUNNEL_LOG" ] && tail -20 "$TUNNEL_LOG"
    send_alert "⚠️ Bot tunnel restarted $TUNNEL_RESTART_TOTAL times total and gave up. Run \`teams-bot restart\` to recover."
    cleanup
  fi

  echo "[run.sh] Tunnel restart (${TUNNEL_RESTART_COUNT}/${MAX_TUNNEL_RESTARTS}), backoff ${delay}s..."
  [ -n "$TUNNEL_LOG" ] && tail -20 "$TUNNEL_LOG"
  kill "$TUNNEL_PID" 2>/dev/null
  wait "$TUNNEL_PID" 2>/dev/null
  sleep "$delay"
  if ! start_tunnel; then
    echo "[run.sh] Tunnel restart failed."
    TUNNEL_RESTART_COUNT=$((TUNNEL_RESTART_COUNT + 1))
    TUNNEL_RESTART_TOTAL=$((TUNNEL_RESTART_TOTAL + 1))
    if [ "$TUNNEL_RESTART_COUNT" -gt "$MAX_TUNNEL_RESTARTS" ] || [ "$TUNNEL_RESTART_TOTAL" -gt "$MAX_TUNNEL_RESTARTS_TOTAL" ]; then
      echo "[run.sh] Tunnel restart limit reached (consecutive=$TUNNEL_RESTART_COUNT, total=$TUNNEL_RESTART_TOTAL)."
      [ -n "$TUNNEL_LOG" ] && tail -20 "$TUNNEL_LOG"
      send_alert "⚠️ Bot tunnel failed to restart (consecutive=$TUNNEL_RESTART_COUNT, total=$TUNNEL_RESTART_TOTAL). Run \`teams-bot restart\` to recover."
      cleanup
    fi
  fi
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

# Keep TUNNEL_LOG around — devtunnel writes to it continuously.
# This ensures the Unauthorized grep in the recovery loop can see new output.

echo "[run.sh] Bot PID=$BOT_PID, Tunnel PID=$TUNNEL_PID"

# Wait and recover tunnel on transient exits
while [ "$RUNNING" -eq 1 ] && kill -0 "$BOT_PID" 2>/dev/null; do
  NOW=$(date +%s)

  # Reset restart counter after 30 minutes of stable tunnel
  if [ "$TUNNEL_RESTART_COUNT" -gt 0 ] && [ "$LAST_TUNNEL_START" -gt 0 ]; then
    STABLE_DURATION=$((NOW - LAST_TUNNEL_START))
    if [ "$STABLE_DURATION" -ge 1800 ]; then
      echo "[run.sh] Tunnel stable for 30+ min, resetting restart counter."
      TUNNEL_RESTART_COUNT=0
    fi
  fi

  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    if [ -n "$TUNNEL_LOG" ] && grep -qi "Unauthorized" "$TUNNEL_LOG"; then
      echo "[run.sh] Tunnel auth expired or permissions lost."
      tail -20 "$TUNNEL_LOG"
      send_alert "🔑 Tunnel auth expired. Run \`devtunnel user login\` then \`teams-bot restart\`."
      cleanup
    fi

    echo "[run.sh] Tunnel exited."
    restart_tunnel
    continue
  fi

  # Health check: detect stale-but-alive tunnel via public URL
  if [ -n "$BOT_PUBLIC_URL" ]; then
    SINCE_LAST_CHECK=$((NOW - LAST_HEALTH_CHECK))
    if [ "$SINCE_LAST_CHECK" -ge "$HEALTH_CHECK_INTERVAL" ]; then
      LAST_HEALTH_CHECK=$NOW
      if curl -sf --max-time 10 "${BOT_PUBLIC_URL}/healthz" > /dev/null 2>&1; then
        HEALTH_CHECK_FAIL_COUNT=0
      else
        HEALTH_CHECK_FAIL_COUNT=$((HEALTH_CHECK_FAIL_COUNT + 1))
        echo "[run.sh] Health check failed (${HEALTH_CHECK_FAIL_COUNT}/2)"
        if [ "$HEALTH_CHECK_FAIL_COUNT" -ge 2 ]; then
          echo "[run.sh] Tunnel alive but unhealthy (2 consecutive failures). Restarting..."
          HEALTH_CHECK_FAIL_COUNT=0
          restart_tunnel
          continue
        fi
      fi
    fi
  fi

  sleep 1
done

echo "[run.sh] Bot process exited, cleaning up..."
cleanup
