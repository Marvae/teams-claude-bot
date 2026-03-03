---
name: handoff
description: Hand off the current Claude Code session to Microsoft Teams for mobile continuation
---

# Handoff to Teams

When the user runs `/handoff`:

1. You know your own session ID (it's the same one shown when you /exit). Use it directly.

2. Call the handoff API:

```bash
curl -s -X POST http://localhost:3978/api/handoff \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "SESSION_ID_HERE", "workDir": "CURRENT_WORKING_DIR"}'
```

Replace SESSION_ID_HERE with your actual session ID and CURRENT_WORKING_DIR with the result of `pwd`.

3. If the response contains `"success": true`, display:

```
Handoff sent! Check your phone.

Type /exit to close this session, then continue on Teams.
```

4. If the API call fails, display:

```
Handoff failed - Teams Bot is not running.
```
