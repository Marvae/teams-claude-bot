---
name: handoff
description: Hand off the current Claude Code session to Microsoft Teams for mobile continuation
allowed-tools: Bash(curl *)
---

# Handoff to Teams

Session ID: ${CLAUDE_SESSION_ID}

When the user runs `/handoff`:

1. The session ID is already available above via template variable. If it shows as empty or literal `${CLAUDE_SESSION_ID}`, ask the user to run /status and paste their Session ID.

2. **Generate a session summary** based on the current conversation, in the **same language as the conversation** (do NOT default to English). Construct the full JSON body with these fields:
   - `workDir`: current working directory (forward slashes only, e.g. `C:/Users/...`)
   - `sessionId`: the session ID from above
   - `title`: card title (e.g. "Session Summary" / "会话摘要")
   - `summary`: 1-2 sentence summary of what was discussed/done
   - `todos`: array of `{"content": "...", "done": true/false}` — omit if none
   - `buttonText`: accept button label (e.g. "Continue" / "继续")

3. Send via curl with a single-quoted heredoc (no shell expansion, safe for unicode and special chars):

```bash
curl -s -X POST "${TEAMS_BOT_URL:-http://localhost:3978}/api/handoff" \
  -H "Content-Type: application/json" \
  -H "x-handoff-token: $(cat "$HOME/.claude/teams-bot/handoff-token" 2>/dev/null)" \
  -w "\nHTTP_STATUS:%{http_code}" \
  -d @- <<'EOF'
YOUR_JSON_HERE
EOF
```

IMPORTANT: Replace `YOUR_JSON_HERE` with the actual JSON from step 2. The heredoc is single-quoted — content is passed verbatim, no escaping needed.

4. Parse the JSON response. If `success` is true: `Handoff sent! Check Teams to continue. You can keep working here — both sides are independent.`
5. If `success` is false or HTTP_STATUS is not 200: show the `error` field from the response. Common errors:
   - "First time setup: send any message to the bot in Teams first" → user needs to message the bot once
   - "Conversation expired" → user needs to send a message to refresh
   - "Teams rejected" / "bot token" → bot credentials issue
   - Connection refused → bot is not running, try `teams-bot start`
