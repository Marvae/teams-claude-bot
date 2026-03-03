#!/bin/bash
# Get current Claude Code session ID by walking up the process tree.
# Falls back to $CLAUDE_SESSION_ID (set by SessionStart hook).
get_session_id() {
  local pid=$$
  while [ "$pid" != "1" ] && [ -n "$pid" ]; do
    local args=$(ps -o args= -p "$pid" 2>/dev/null)
    if echo "$args" | grep -q "^claude"; then
      local sid=$(echo "$args" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
      if [ -n "$sid" ]; then
        echo "$sid"
        return
      fi
      break
    fi
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  done
  echo "$CLAUDE_SESSION_ID"
}

get_session_id
