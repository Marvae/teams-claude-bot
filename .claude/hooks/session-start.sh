#!/bin/bash
INPUT=$(cat)

# Try jq first, fall back to Python
if command -v jq &>/dev/null; then
  SID=$(echo "$INPUT" | jq -r '.session_id' 2>/dev/null)
  CWD=$(echo "$INPUT" | jq -r '.cwd' 2>/dev/null)
elif command -v python3 &>/dev/null; then
  SID=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null)
  CWD=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('cwd',''))" 2>/dev/null)
elif command -v python &>/dev/null; then
  SID=$(echo "$INPUT" | python -c "import sys,json; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null)
  CWD=$(echo "$INPUT" | python -c "import sys,json; d=json.load(sys.stdin); print(d.get('cwd',''))" 2>/dev/null)
fi

# Write to known location so get-session-id.sh can find it on any platform
if [ -n "$SID" ] && [ "$SID" != "null" ]; then
  echo "$SID" > "$HOME/.claude/current-session-id"
fi

# Legacy: also write to CLAUDE_ENV_FILE if set
if [ -n "$CLAUDE_ENV_FILE" ]; then
  printf 'export CLAUDE_SESSION_ID="%s"\n' "$SID" >> "$CLAUDE_ENV_FILE"
  printf 'export CLAUDE_SESSION_CWD="%s"\n' "$CWD" >> "$CLAUDE_ENV_FILE"

  # Inject HANDOFF_TOKEN from teams-claude-bot .env so /handoff works without manual setup
  BOT_ENV="$HOME/repos/teams-claude-bot/.env"
  if [ -f "$BOT_ENV" ]; then
    TOKEN=$(grep '^HANDOFF_TOKEN=' "$BOT_ENV" | cut -d= -f2-)
    if [ -n "$TOKEN" ]; then
      printf 'export HANDOFF_TOKEN="%s"\n' "$TOKEN" >> "$CLAUDE_ENV_FILE"
    fi
  fi
fi
