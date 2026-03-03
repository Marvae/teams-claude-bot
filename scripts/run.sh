#!/bin/bash
cd "$(dirname "$0")/.."

# Load env vars
set -a
source .env 2>/dev/null
set +a

cleanup() {
  echo "[run.sh] Shutting down..."
  kill $BOT_PID $TUNNEL_PID 2>/dev/null
  wait $BOT_PID $TUNNEL_PID 2>/dev/null
  echo "[run.sh] All processes stopped"
  exit 0
}

trap cleanup INT TERM EXIT

# Start bot and tunnel
node dist/index.js &
BOT_PID=$!

devtunnel host peaceful-plane-fm228kq &
TUNNEL_PID=$!

echo "[run.sh] Bot PID=$BOT_PID, Tunnel PID=$TUNNEL_PID"

# Wait for either to exit
while kill -0 $BOT_PID 2>/dev/null && kill -0 $TUNNEL_PID 2>/dev/null; do
  wait -p EXITED_PID $BOT_PID $TUNNEL_PID 2>/dev/null || sleep 1
done

echo "[run.sh] A child process exited, cleaning up..."
cleanup
