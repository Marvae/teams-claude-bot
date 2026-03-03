---
name: handoff
description: Hand off the current Claude Code session to Microsoft Teams for mobile continuation
allowedTools:
  - Bash(curl*)
  - Bash(*/get-session-id.sh)
  - Bash(echo*)
  - Bash(ps*)
---

# Handoff to Teams

When the user runs `/handoff`:

1. Get the session ID using the helper script:

```bash
SKILL_DIR="$(dirname "$(readlink -f ~/.claude/skills/handoff/SKILL.md 2>/dev/null || echo .claude/skills/handoff/SKILL.md)")"
SID=$("$SKILL_DIR/get-session-id.sh")
echo "SESSION_ID=${SID:-not found}"
```

2. If session ID is empty, ask the user to run /status and paste their Session ID.

3. Call the handoff API:

```bash
curl -s -X POST "${TEAMS_BOT_URL:-http://localhost:3978}/api/handoff" \
  -H "Content-Type: application/json" \
  ${HANDOFF_TOKEN:+-H "x-handoff-token: $HANDOFF_TOKEN"} \
  -d "{\"sessionId\": \"$SID\", \"workDir\": \"$(pwd)\"}"
```

4. If the response contains `"success": true`:

```
Handoff sent! Check Teams to continue. You can keep working here — both sides work independently.
```

5. If the API call fails:

```
Handoff failed - is the Teams Bot running?
```
