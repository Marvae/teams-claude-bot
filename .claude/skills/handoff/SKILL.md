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

3. **Generate a session summary** before calling the API. Based on the current conversation, prepare these fields in the **same language as the conversation** (do NOT default to English):
   - `title`: card title (e.g., "Session Summary" / "会话摘要" / "セッション概要" — match conversation language)
   - `summary`: 1-2 sentence summary of what was discussed/done
   - `todos`: JSON array of tasks `[{"content": "task description", "done": true/false}]` — omit if no tasks
   - `buttonText`: the accept button label (e.g., "Continue" / "继续" / "続ける" — match conversation language)

4. Call the handoff API. Construct the full JSON payload directly in the curl command — do NOT use sed or placeholder substitution. Use proper JSON escaping for all values:

```bash
curl -s --ipv4 -w "\nHTTP_STATUS:%{http_code}" -X POST "${TEAMS_BOT_URL:-http://localhost:3978}/api/handoff" \
  -H "Content-Type: application/json" \
  -H "x-handoff-token: $HANDOFF_TOKEN" \
  -d '{ ... your JSON here ... }'
```

IMPORTANT: You must fill in the actual summary, todos, and buttonText values based on the conversation context. Do NOT use placeholders.

5. If the response contains `"success":true` or HTTP_STATUS is 200:

```
Handoff sent! A forked session has been created on Teams — check Teams to continue.
You can keep working here — both sides work independently on the same codebase.
```

6. If the API call fails or HTTP_STATUS is not 200:

```
Handoff failed - is the Teams Bot running?
```
