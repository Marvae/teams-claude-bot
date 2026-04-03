# CLAUDE.md — teams-claude-bot

## What this project is

A Microsoft Teams bot that bridges to Claude Code via the Agent SDK. Users chat in Teams, messages route to a local Claude Code session, responses stream back.

## Key architecture

- **Runtime:** Node.js 22+, ESM, TypeScript
- **Teams SDK:** `@microsoft/teams.apps` + `@microsoft/teams.api` + `@microsoft/teams.cards` (v2, NOT legacy botbuilder)
- **AI:** `@anthropic-ai/claude-agent-sdk` for full Claude Code sessions
- **Server:** Express 5 on port 3978 (configurable via PORT env)
- **DevTools:** `@microsoft/teams.dev` DevtoolsPlugin on port 3979 (dev mode only)
- **CLI:** `teams-bot` command (Commander.js) for setup, service management, and testing

## Testing after code changes

### Unit tests (no network, no Claude API)
```bash
npm test
```
217 tests covering commands, card actions, streaming, permissions, handoff.
Claude SDK is mocked — these test bot logic only.

### E2E test via DevTools (real Claude API, no Teams/tunnel needed)
The bot must be running in dev mode first:
```bash
npm run dev:local    # start bot with DevTools
```

Then in another terminal:
```bash
# Interactive REPL
npx teams-bot test

# One-shot message (hits real Claude API)
npx teams-bot test "What is 2+2?"

# Simulate Adaptive Card click
npx teams-bot test --card prompt_response

# Diagnose connectivity (bot → DevTools → tunnel)
npx teams-bot test --diagnose
```

DevTools sends activities to `http://localhost:3979/v3/conversations/.../activities` with
`x-teams-devtools: true` header. This bypasses Teams auth and tunnel but runs the full
bot pipeline including Claude Agent SDK.

### What to verify after changes
1. `npm test` — all green
2. `npx teams-bot test --diagnose` — all OK
3. `npx teams-bot test "hello"` — bot responds via real Claude
4. If touching Adaptive Card logic: `npx teams-bot test --card <action>`

## Build
```bash
npm run build          # bot + CLI
npm run dev:local      # watch mode (bot only)
npm run dev            # watch mode + tunnel
```

## Project structure
```
src/
  bot/          Teams bot handlers (message, cards, bridge)
  claude/       Agent SDK integration (session, permissions, user-input)
  cli/          CLI commands (setup, service, test)
  handoff/      Handoff flow (store, cards)
  config.ts     Environment config
  index.ts      Express server + Teams App setup
tests/          Vitest tests
manifest/       Teams app manifest template
```

## Conventions
- All source is TypeScript with strict mode
- ESM only — no `require()` anywhere
- Tests use vitest with mocked Agent SDK
- Adaptive Cards use `@microsoft/teams.cards` builders where possible
- Card actions use `Action.Submit` with `data.action` field for routing
