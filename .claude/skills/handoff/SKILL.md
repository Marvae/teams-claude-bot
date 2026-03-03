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

When the user runs `/handoff` (with optional argument `pickup`, `resume`, or no argument):

1. Get the session ID using the helper script:

```bash
SKILL_DIR="$(dirname "$(readlink -f ~/.claude/skills/handoff/SKILL.md 2>/dev/null || echo .claude/skills/handoff/SKILL.md)")"
SID=$("$SKILL_DIR/get-session-id.sh")
echo "SESSION_ID=${SID:-not found}"
```

2. If session ID is empty, ask the user to run /status and paste their Session ID.

3. Determine the mode from the user's argument:
   - `/handoff` → mode is empty (Teams will show a choice card)
   - `/handoff pickup` → mode is "pickup"
   - `/handoff resume` → mode is "resume"

4. Call the handoff API:

```bash
MODE=""  # set to "pickup" or "resume" if user specified, otherwise leave empty
curl -s -X POST "${TEAMS_BOT_URL:-http://localhost:3978}/api/handoff" \
  -H "Content-Type: application/json" \
  ${HANDOFF_TOKEN:+-H "x-handoff-token: $HANDOFF_TOKEN"} \
  -d "{\"sessionId\": \"$SID\", \"workDir\": \"$(pwd)\"${MODE:+, \"mode\": \"$MODE\"}}"
```

5. If the response contains `"success": true`, display EXACTLY one of these based on MODE:

- MODE is empty (default): `Handoff sent! Check your phone to choose how to continue.`
- MODE is "pickup": `Handoff sent! You can keep working here — both sides work independently.`
- MODE is "resume": `Handoff sent! Close this session with /exit before resuming on Teams.`

IMPORTANT: Do NOT mention /exit unless MODE is "resume".

6. If the API call fails, display:

```
Handoff failed - is the Teams Bot running?
```
