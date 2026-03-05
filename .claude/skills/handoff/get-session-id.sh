#!/bin/bash
# Get current Claude Code session ID.
# 1. Walk up the process tree looking for a claude process with a UUID arg.
# 2. Fall back to ~/.claude/current-session-id (written by SessionStart hook).
# 3. Fall back to $CLAUDE_SESSION_ID env var (legacy).
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

  # SessionStart hook writes the session ID here on every session start
  local id_file="$HOME/.claude/current-session-id"
  if [ -f "$id_file" ]; then
    local sid=$(cat "$id_file" 2>/dev/null | tr -d '[:space:]')
    if [ -n "$sid" ]; then
      echo "$sid"
      return
    fi
  fi

  echo "$CLAUDE_SESSION_ID"
}

get_session_id
