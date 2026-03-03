#!/bin/bash
INPUT=$(cat)

if [ -n "$CLAUDE_ENV_FILE" ]; then
  SID=$(echo "$INPUT" | jq -r '.session_id' 2>/dev/null)
  CWD=$(echo "$INPUT" | jq -r '.cwd' 2>/dev/null)
  # Quote values to handle spaces/special chars in paths
  printf 'export CLAUDE_SESSION_ID="%s"\n' "$SID" >> "$CLAUDE_ENV_FILE"
  printf 'export CLAUDE_SESSION_CWD="%s"\n' "$CWD" >> "$CLAUDE_ENV_FILE"
fi
