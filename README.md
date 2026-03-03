# Claude Code Teams Bot

A lightweight Microsoft Teams bot that bridges to Claude Code on your local machine. Chat with Claude Code from any device — no SSH, no VPN, just Teams.

> **FHL Project — Changing how we work in the era of AI**
>
> AI coding assistants are powerful but tied to your terminal. This bot puts Claude Code in Teams so you can read, edit, and run code on your dev machine from anywhere. Deliberately minimal compared to heavier solutions like openclaw — easy to audit, easy to self-host, built-in access control.

## Features

- **Full Claude Code access** — Read, Write, Edit, Bash, Glob, Grep tools via Teams messages
- **Image & file upload** — Send screenshots for Claude to analyze, or upload code files for review
- **Handoff** — Seamlessly switch between Terminal and Teams with `/handoff` skill
  - **Quick Pickup** — New session with conversation summary (both sides work independently)
  - **Resume Session** — Take over the exact Terminal session (requires closing Terminal first)
  - **Handoff Back** — Return session to Terminal with `/handoff back`
- **Access control** — Restrict usage to authorized users via Azure AD object ID or email
- **Session management** — Per-conversation session, working directory, model, and thinking budget
  - Session history with `/sessions` (Adaptive Card with Resume buttons)
  - Session persistence across bot restarts (`.sessions.json`)
- **Slash commands** — `/model`, `/project`, `/thinking`, `/permission`, `/new`, `/status`, `/sessions`, `/handoff`, `/help`
- **Typing indicators** — Shows "typing..." while Claude is processing
- **Message chunking** — Auto-splits long responses to fit Teams' 25KB limit
- **Friendly error handling** — User-friendly error messages instead of raw stack traces

## Architecture

```
Teams (any device)
  → Bot Framework SDK
    → Express server (/api/messages, /api/handoff)
      → Claude Agent SDK
        → Claude Code (local machine)
```

### Project Structure

```
src/
├── index.ts                 # Express server (bot endpoint + handoff API)
├── config.ts                # Env var parsing (app credentials, allowed users)
├── bot/
│   ├── teams-bot.ts         # Main ActivityHandler (auth, attachments, handoff, routing)
│   ├── commands.ts          # Slash command handling
│   ├── attachments.ts       # Download & process Teams file/image attachments
│   ├── mention.ts           # Strip @mentions in group chats
│   └── cards.ts             # Adaptive card builders
├── claude/
│   ├── agent.ts             # Claude Agent SDK integration (query, session lookup, summary)
│   └── formatter.ts         # Response formatting & message splitting
├── handoff/
│   └── store.ts             # Conversation reference storage (for proactive messages)
└── session/
    └── manager.ts           # Session persistence, history, handoff mode tracking

.claude/
├── skills/handoff/
│   ├── SKILL.md             # /handoff skill for Claude Code CLI
│   └── get-session-id.sh    # Session ID extraction via process tree
└── hooks/
    └── session-start.sh     # SessionStart hook to capture session ID
```

### Handoff Flow

```
Terminal → Teams (Quick Pickup):
1. User runs /handoff in Terminal
2. Skill extracts session ID, calls POST /api/handoff
3. Bot sends Adaptive Card to Teams with Quick Pickup / Resume buttons
4. User taps Quick Pickup → Bot reads Terminal transcript summary
5. Bot starts new session with summary injected as context
6. Both Terminal and Teams can work independently

Terminal → Teams (Resume):
1. Same as above, but user taps Resume
2. User must /exit Terminal first
3. Bot resumes the exact same session with full context

Teams → Terminal:
1. User sends /handoff back in Teams
2. Pickup mode: Teams session stays, Terminal is still active
3. Resume mode: Bot shows `claude -r <id>` command, clears Teams session
```

### Message Flow

```
1. User sends message in Teams (text, image, or file)
2. Save conversation reference (for proactive handoff notifications)
3. Access control check (ALLOWED_USERS whitelist)
4. Handle Adaptive Card button clicks (handoff, session switch)
5. Process attachments:
   - Images → base64 → Claude vision content block
   - Text/code files → prepend to prompt as code block
   - Unsupported → notify user, skip
6. Route slash commands
7. Start typing indicator loop (3s interval)
8. Call Claude Agent SDK query() with prompt + images
9. Collect session ID, tool usage, and result
10. Format response (tools used + result)
11. Split into chunks, send back to Teams
```

### Access Control

Set `ALLOWED_USERS` env var with comma-separated Azure AD object IDs or emails:

```bash
ALLOWED_USERS=user1@contoso.com,user2@contoso.com
```

- If unset or empty → open access (for dev/testing)
- Checks `activity.from.aadObjectId` and `activity.from.name`
- Case-insensitive matching
- Denied users get a brief "not authorized" message

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
   CLAUDE_WORK_DIR=~/Work                   # optional, default ~/Work
   ALLOWED_USERS=                           # optional, comma-separated whitelist
   HANDOFF_TOKEN=                           # optional, shared secret for /api/handoff
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
   This creates a persistent tunnel, so the URL stays the same.

4. **Start the bot**
   ```bash
   npm run dev
   ```

5. **Upload the Teams app manifest** from `manifest/` to Teams admin center.

6. **Update messaging endpoint** in Azure Bot registration → `<tunnel-url>/api/messages`.

7. **Send a message to the bot in Teams** — This is a one-time setup to enable handoff notifications.

8. **Install as background service**
   ```bash
   npm link          # Register the CLI command
   teams-bot install # Install service + auto-start on login + optional /handoff skill
   ```

## Commands

| Command | Description |
|---------|-------------|
| `/new` | Start a fresh Claude session |
| `/clear` | Clear current session |
| `/compact` | Compact session history |
| `/project <path>` | Set working directory |
| `/model [name]` | Show or set model (sonnet/opus/haiku) |
| `/models` | List available models |
| `/thinking [tokens\|off]` | Set extended thinking budget |
| `/permission [mode]` | Set permission mode |
| `/sessions` | View session history (Adaptive Card with Resume buttons) |
| `/handoff back` | Hand session back to Terminal |
| `/status` | Show current session config |
| `/help` | Show command card |

Any other message is sent to Claude Code as a prompt.

### Handoff Skill (Terminal → Teams)

Install the `/handoff` skill for Claude Code:

```bash
teams-bot install-skill    # Interactive setup (global or project scope)
teams-bot uninstall-skill  # Remove skill and hook
```

Then in any Claude Code session:

```
/handoff              # Teams shows choice card (Quick Pickup or Resume)
/handoff pickup       # Direct quick pickup (no card)
/handoff resume       # Direct resume (no card)
```

## Service Management

```bash
teams-bot install         # Install + auto-start on login
teams-bot install-skill   # Install /handoff skill for Claude Code
teams-bot uninstall-skill # Remove /handoff skill
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
```

## Tech Stack

- **TypeScript** — Strict mode, ESM
- **Bot Framework SDK** (`botbuilder` v4.23) — Teams message handling
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk` v0.1) — Claude Code integration
- **Express** — HTTP server
- **esbuild** — Bundler (single-file output, Node 22 target)
- **vitest** — Testing
