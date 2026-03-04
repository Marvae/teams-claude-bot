# Claude Code Teams Bot

A lightweight Microsoft Teams bot that bridges to Claude Code on your local machine. Chat with Claude Code from any device — no SSH, no VPN, just Teams.

> **FHL Project — Changing how we work in the era of AI**
>
> AI coding assistants are powerful but tied to your terminal. This bot puts Claude Code in Teams so you can read, edit, and run code on your dev machine from anywhere. Deliberately minimal compared to heavier solutions like openclaw — easy to audit, easy to self-host, built-in access control.

## Features

- **Full Claude Code access** — Read, Write, Edit, Bash, Glob, Grep tools via Teams messages
- **Image & file upload** — Send screenshots for Claude to analyze, or upload code files for review
- **Streaming responses** — Real-time progress via Teams streaming protocol (typing indicators)
- **Diff image rendering** — Code changes displayed as syntax-highlighted diff images (optional)
- **Todo tracking** — Complex tasks show inline progress (✅🔧⏳) with live counter
- **Prompt suggestions** — Quick-reply button after each turn for natural follow-ups
- **Session management** — Single long-lived session with auto-resume on restart
  - Only sessionId + permissionMode persisted to disk
  - `/sessions` browser — lists all SDK sessions with summary, project, branch
  - Resume any session via buttons (path-validated against allowed work directory)
  - Message queuing — messages sent while busy are queued, not dropped
  - Usage tracking — `/status` shows cumulative cost, tokens, and turns
- **Permission control** — Dynamic permission modes, changeable without restarting session
  - Default, Accept Edits, Plan, Don't Ask, Bypass modes
  - Interactive tool approval via compact Adaptive Cards
  - Expandable details for long tool inputs
- **Handoff** — Two-step Terminal ↔ Teams handoff with confirmation card
  - Terminal → Teams: `/handoff` sends card, user clicks Accept to fork session
  - Both sides continue working independently
  - `/handoff back`: Clear handoff mode
- **MCP & Elicitation** — MCP server auth flows (form + URL) via Adaptive Cards
- **Access control** — Restrict usage via Azure AD object ID or email whitelist
- **Security** — Rate limiting, security headers, file permission hardening, activity dedup
- **Slash commands** — `/new`, `/stop`, `/model`, `/project`, `/thinking`, `/permission`, `/sessions`, `/status`, `/handoff`, `/help`
- **SDK commands** — Claude Code skills (compact, cost, review, etc.) available via `/help`

## Architecture

```
Teams (any device)
  → Bot Framework SDK
    → Express server (/api/messages, /api/handoff)
      → Claude Agent SDK (streaming input mode)
        → Claude Code (local machine)
```

### Key Design Decisions

- **Single session, no Map** — One live ConversationSession at a time (module-level variable). Optimized for 1:1 private chat.
- **Streaming input mode** — Single long-lived `query()` with `AsyncQueue`. Messages pushed via queue, no process restart between turns.
- **Minimal persistence** — Only `sessionId` and `permissionMode` written to disk. Everything else is in-memory.
- **Dynamic control** — `setPermissionMode()` and `setModel()` modify the running query without restart.
- **SDK as source of truth** — `listSessions()` for session history, `supportedCommands()` for slash commands.

### Project Structure

```
src/
├── index.ts                 # Express server (bot endpoint + handoff API + rate limiting)
├── config.ts                # Env var parsing (app credentials, allowed users)
├── bot/
│   ├── teams-bot.ts         # Main ActivityHandler (message handling, progress, handoff)
│   ├── commands.ts          # Slash command handling (all use state module)
│   ├── attachments.ts       # Download & process Teams file/image attachments
│   ├── mention.ts           # Strip @mentions in group chats
│   └── cards.ts             # Adaptive card builders (help, permission, handoff, etc.)
├── claude/
│   ├── agent.ts             # SDK types & helpers (ToolInfo, ProgressEvent, TodoItem)
│   ├── session.ts           # ConversationSession — long-lived SDK query wrapper
│   ├── formatter.ts         # Response formatting & message splitting
│   ├── permissions.ts       # Tool permission handler (canUseTool callback)
│   ├── elicitation.ts       # MCP server elicitation (form + URL auth flows)
│   ├── user-input.ts        # PromptRequest handler
│   └── user-questions.ts    # AskUserQuestion tool handler
├── handoff/
│   └── store.ts             # Conversation reference storage (for proactive messages)
└── session/
    ├── state.ts             # Unified session state (persistence, preferences, usage stats)
    └── async-queue.ts       # AsyncQueue for streaming input to SDK

.claude/
├── skills/handoff/
│   ├── SKILL.md             # /handoff skill for Claude Code CLI
│   └── get-session-id.sh    # Session ID extraction via process tree
└── hooks/
    └── session-start.sh     # SessionStart hook to capture session ID
```

### Message Flow

```
1. Dedup check (ignore Teams duplicate webhooks)
2. Access control (ALLOWED_USERS whitelist)
3. Handle Adaptive Card actions (permission, handoff, elicitation, etc.)
4. Process attachments (images → base64, text files → prepend to prompt)
5. Route slash commands (all read/write from unified state module)
6. Get or create session (lazy — first message triggers creation with auto-resume)
7. Queue if busy, or send to session
8. Stream progress: todo list + tool calls + partial text (updateActivity)
9. On completion: replace progress with final response + prompt suggestion
```

### Handoff Flow

```
Terminal → Teams:
1. User runs /handoff in Terminal
2. Skill calls POST /api/handoff with sessionId + workDir
3. Bot sends confirmation card to Teams
4. User clicks "Accept Handoff" → session forked, both sides independent

Teams → Terminal:
1. User sends /handoff back
2. Clears handoff mode, Teams session stays active
```

### Permission Flow

```
1. Claude requests tool use → SDK calls canUseTool callback
2. Bot sends compact Adaptive Card (tool name + one-line summary)
3. Long inputs have expandable "Details" section
4. User taps Allow or Deny → card updated in-place with result
5. /permission <mode> changes mode dynamically on running query
```

## Prerequisites

- Node.js 22+
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
- Azure Bot registration
- Microsoft Teams (admin access to upload custom apps)

## Setup

1. **Clone and install**
   ```bash
   git clone <repo-url>
   cd teams-claude-bot
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   ```
   ```bash
   # .env
   MICROSOFT_APP_ID=<your-bot-app-id>
   MICROSOFT_APP_PASSWORD=<your-bot-password>
   MICROSOFT_APP_TENANT_ID=<your-tenant-id>
   DEVTUNNEL_ID=<your-devtunnel-id>        # created during setup
   PORT=3978                                # optional, default 3978
   CLAUDE_WORK_DIR=~/Work                   # required, must exist
   ALLOWED_USERS=                           # optional, comma-separated whitelist
   HANDOFF_TOKEN=                           # optional, shared secret for /api/handoff
   BOT_SESSIONS_FILE=                       # optional, default ~/.claude/teams-bot/session.json
   SESSION_INIT_PROMPT=                     # optional, run on new session start
   ```

3. **Create a persistent dev tunnel**
   ```bash
   devtunnel create --id my-teams-bot --allow-anonymous
   devtunnel port create my-teams-bot -p 3978
   ```
   The `--id` value is your custom name (e.g., `my-teams-bot`, `claude-bot`). This is your `DEVTUNNEL_ID`.
   ```bash
   # .env
   DEVTUNNEL_ID=my-teams-bot
   ```

4. **Start the bot**
   ```bash
   npm run dev
   ```

5. **Upload the Teams app manifest** from `manifest/` to Teams admin center.

6. **Update messaging endpoint** in Azure Bot registration → `<tunnel-url>/api/messages`.

7. **Send a message to the bot in Teams** — One-time setup to enable handoff notifications.

8. **Install as background service** (macOS)
   ```bash
   npm link          # Register the CLI command
   teams-bot install # Install service + auto-start on login + optional /handoff skill
   ```

## Commands

| Command | Description |
|---------|-------------|
| `/new` | Start a fresh Claude session |
| `/stop` | Interrupt current task, clear pending queue |
| `/project <path>` | Set working directory |
| `/model [name]` | Show or set model (sonnet/opus/haiku) — applies immediately |
| `/models` | List available models |
| `/thinking [tokens\|off]` | Set extended thinking budget |
| `/permission [mode]` | Set permission mode — applies immediately |
| `/sessions` | Browse and resume past sessions |
| `/handoff back` | Hand session back to Terminal |
| `/status` | Show session info + cumulative usage stats |
| `/help` | Show all commands (bot + Claude Code skills) |

Any other `/command` is forwarded to Claude Code as a slash command. Any other message is sent as a prompt.

### Permission Modes

| Mode | Behavior |
|------|----------|
| `default` | Ask before risky operations (recommended) |
| `acceptEdits` | Auto-allow file edits, ask for others |
| `plan` | Planning only, no tool execution |
| `dontAsk` | Auto-approve all tools |
| `bypassPermissions` | Allow everything without asking |

Permission mode is persisted across restarts and applied dynamically without restarting the session.

### Handoff Skill (Terminal → Teams)

Install the `/handoff` skill for Claude Code:

```bash
teams-bot install-skill    # Interactive setup (global or project scope)
teams-bot uninstall-skill  # Remove skill and hook
```

Then in any Claude Code session:

```
/handoff    # Hand off to Teams
```

## Service Management

```bash
teams-bot install         # Install + auto-start on login
teams-bot install-skill   # Install /handoff skill for Claude Code
teams-bot uninstall-skill # Remove /handoff skill
teams-bot enable-diff     # Enable diff image rendering (downloads ~200MB)
teams-bot status          # Check if running
teams-bot logs            # Tail logs
teams-bot restart         # Rebuild + restart
teams-bot stop            # Stop service
teams-bot uninstall       # Remove service
```

## Development

```bash
npm run dev        # Hot reload (tsx + watch)
npm run dev:local  # Hot reload without tunnel
npm run build      # Production build (esbuild)
npm start          # Run production build
npm test           # Run tests (vitest)
npm run test:watch # Watch mode tests
npm run lint       # ESLint
npm run format     # Prettier
```

## Tech Stack

- **TypeScript** — Strict mode, ESM
- **Bot Framework SDK** (`botbuilder` v4.23) — Teams message handling
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — Claude Code integration
- **Express** — HTTP server with rate limiting and security headers
- **esbuild** — Bundler (single-file output, Node 22 target)
- **@pierre/diffs + playwright-core** — Diff image rendering (optional)
- **vitest** — Testing
- **ESLint + Prettier** — Code quality
