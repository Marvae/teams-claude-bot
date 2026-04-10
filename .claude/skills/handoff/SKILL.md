---
name: handoff
description: Hand off the current Claude Code session to Microsoft Teams for mobile continuation
allowedTools:
  - "Bash(node -e *)"
---

# Handoff to Teams

Session ID: ${CLAUDE_SESSION_ID}

When the user runs `/handoff`:

1. The session ID is already available above via template variable. If it shows as empty or literal `${CLAUDE_SESSION_ID}`, ask the user to run /status and paste their Session ID.

2. **Generate a session summary** before calling the API. Based on the current conversation, prepare these fields in the **same language as the conversation** (do NOT default to English):
   - `workDir`: the current working directory (use `pwd`, always use forward slashes)
   - `sessionId`: the session ID from above
   - `title`: card title (e.g., "Session Summary" / "会话摘要" / "セッション概要" — match conversation language)
   - `summary`: 1-2 sentence summary of what was discussed/done
   - `todos`: JSON array of tasks `[{"content": "task description", "done": true/false}]` — omit if no tasks
   - `buttonText`: the accept button label (e.g., "Continue" / "继续" / "続ける" — match conversation language)

3. Call the handoff API using node to avoid shell escaping issues with JSON, unicode, and Windows paths. Build the JSON payload in JavaScript directly — do NOT use curl with inline JSON:

```bash
node -e "
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const payload = JSON.stringify({
  workDir: 'WORK_DIR_HERE',
  sessionId: 'SESSION_ID_HERE',
  title: 'TITLE_HERE',
  summary: 'SUMMARY_HERE',
  todos: TODOS_ARRAY_HERE,
  buttonText: 'BUTTON_TEXT_HERE'
});
const url = new URL(process.env.TEAMS_BOT_URL || 'http://localhost:3978');
let token;
try { token = process.env.HANDOFF_TOKEN || fs.readFileSync(path.join(os.homedir(), '.claude/teams-bot/handoff-token'), 'utf8').trim(); } catch { token = ''; }
const req = http.request({
  hostname: url.hostname, port: url.port || 3978, path: '/api/handoff',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-handoff-token': token }
}, res => {
  let body = '';
  res.on('data', c => body += c);
  res.on('end', () => console.log(body + '\nHTTP_STATUS:' + res.statusCode));
});
req.on('error', e => console.log(JSON.stringify({error: e.message}) + '\nHTTP_STATUS:0'));
req.write(payload);
req.end();
"
```

IMPORTANT: Replace all placeholder values with actual values from step 2. Use proper JavaScript string escaping. For workDir on Windows, always use forward slashes (C:/Users/... not C:\Users\...).

4. If the response contains `"success":true` or HTTP_STATUS is 200:

```
Handoff sent! A forked session has been created on Teams — check Teams to continue.
You can keep working here — both sides work independently on the same codebase.
```

5. If the API call fails or HTTP_STATUS is not 200:

```
Handoff failed - is the Teams Bot running?
```
