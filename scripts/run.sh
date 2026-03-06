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

# Ensure devtunnel is findable (WinGet installs to a path not always in bash PATH)
if ! command -v devtunnel &>/dev/null; then
  export PATH="$PATH:/c/Users/$USER/AppData/Local/Microsoft/WinGet/Links"
fi

cleanup() {
  echo "[run.sh] Shutting down..."
  kill $BOT_PID $TUNNEL_PID 2>/dev/null
  wait $BOT_PID $TUNNEL_PID 2>/dev/null
  echo "[run.sh] All processes stopped"
  exit 0
}

trap cleanup INT TERM EXIT

# Start bot
node dist/index.js &
BOT_PID=$!

# Start tunnel with error detection
TUNNEL_LOG=$(mktemp)
devtunnel host "$TUNNEL_ID" > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

# Wait a few seconds and check if tunnel started
sleep 3
if ! kill -0 $TUNNEL_PID 2>/dev/null; then
  echo "[run.sh] ERROR: Tunnel failed to start!"
  echo ""
  cat "$TUNNEL_LOG"
  echo ""
  if grep -q "Unauthorized" "$TUNNEL_LOG"; then
    echo "[run.sh] Tunnel auth expired or permissions lost."
    echo ""
    echo "  Fix steps:"
    echo "  1. devtunnel user logout && devtunnel user login"
    echo "  2. Try again: teams-bot restart"
  fi
  rm -f "$TUNNEL_LOG"
  cleanup
fi

# Print tunnel URL
cat "$TUNNEL_LOG"
rm -f "$TUNNEL_LOG"

echo "[run.sh] Bot PID=$BOT_PID, Tunnel PID=$TUNNEL_PID"

# Wait for either to exit
while kill -0 $BOT_PID 2>/dev/null && kill -0 $TUNNEL_PID 2>/dev/null; do
  wait -p EXITED_PID $BOT_PID $TUNNEL_PID 2>/dev/null || sleep 1
done

echo "[run.sh] A child process exited, cleaning up..."
cleanup
