---
name: teams-devtools
description: Test and debug the Teams bot via DevTools without needing Teams or a dev tunnel. Use when verifying bot changes, debugging Adaptive Card actions, diagnosing connectivity issues, or checking the bot pipeline after code modifications.
argument-hint: "[message or --diagnose]"
---

# Teams DevTools

Test the Teams bot through the DevTools API (localhost, no Teams/tunnel needed). This runs the full bot pipeline including Claude Agent SDK.

## Prerequisites

Check if bot is running:

```bash
curl -sf http://localhost:3978/healthz > /dev/null 2>&1 && echo "Bot running" || echo "Bot not running"
```

If not running, start it:

```bash
npm run dev:local &
sleep 5
```

If you get `EADDRINUSE` (port already in use), see Troubleshooting below.

## How DevTools testing works

- DevTools runs on port **3979** (bot port + 1), only in dev mode (`NODE_ENV !== "production"`)
- Send activities to `http://localhost:3979/v3/conversations/<id>/activities`
- **Must include header `x-teams-devtools: true`** — without it the request is silently ignored
- Listen for responses on WebSocket `ws://localhost:3979/devtools/sockets`
- Events: `activity.received` (bot got message), `activity.sent` (bot replied)
- This bypasses Teams auth and tunnel but runs the full bot pipeline

## Quick test via CLI

```bash
npx teams-bot test --diagnose
```

If diagnose passes, send a real message:

```bash
npx teams-bot test "$ARGUMENTS"
```

If no arguments provided, use:

```bash
npx teams-bot test "Say hello"
```

## Testing Adaptive Card actions

To simulate a user clicking a button on an Adaptive Card:

```bash
npx teams-bot test --card prompt_response
```

Available actions: `prompt_response`, `permission_allow`, `permission_deny`, `set_permission_mode`

## Manual testing via curl (when CLI is not available)

### Send a message

```bash
curl -s -X POST "http://localhost:3979/v3/conversations/a:test/activities" \
  -H "Content-Type: application/json" \
  -H "x-teams-devtools: true" \
  -d '{"type":"message","text":"/help"}'
```

### Simulate Adaptive Card Action.Submit

```bash
curl -s -X POST "http://localhost:3979/v3/conversations/a:test/activities" \
  -H "Content-Type: application/json" \
  -H "x-teams-devtools: true" \
  -d '{"type":"message","text":"","value":{"action":"prompt_response","requestId":"test-123","key":"allow"}}'
```

### Listen for responses

```bash
node -e "
const ws = new WebSocket('ws://localhost:3979/devtools/sockets');
ws.addEventListener('message', (e) => {
  const p = JSON.parse(e.data);
  if (p.type === 'activity.sent' && p.body.text) console.log('Bot:', p.body.text);
  if (p.type === 'activity.sent' && p.body.attachments) console.log('Bot: [Adaptive Card]');
});
"
```

## Troubleshooting

### Port already in use (EADDRINUSE)

If you see `Error: listen EADDRINUSE: address already in use :::3978` or `:::3979`:

```bash
# Kill any processes using these ports
lsof -ti:3978 -ti:3979 | xargs kill -9 2>/dev/null
sleep 2
# Then restart
npm run dev:local
```

### Testing works locally but Teams doesn't

1. Run `teams-bot health` to check tunnel connectivity
2. The issue is between tunnel and Teams, not the bot itself

### Testing fails locally

1. Check bot is running: `curl http://localhost:3978/healthz`
2. Check DevTools is enabled: `curl http://localhost:3979/devtools/` (fails if `NODE_ENV=production`)
3. Check WebSocket: connect to `ws://localhost:3979/devtools/sockets`
4. Remember: `x-teams-devtools: true` header is required or requests are silently dropped
