# Claude Code Teams Bot

A lightweight Microsoft Teams bot that bridges to Claude Code on your local machine. Chat with Claude Code from any device — no SSH, no VPN, just Teams.

> **FHL Project — Changing how we work in the era of AI**
>
> AI coding assistants are powerful but tied to your terminal. This bot puts Claude Code in Teams so you can read, edit, and run code on your dev machine from anywhere. Deliberately minimal compared to heavier solutions like openclaw — easy to audit, easy to self-host, built-in access control.

## Features

- **Full Claude Code access** — Read, Write, Edit, Bash, Glob, Grep tools via Teams messages
- **Image & file upload** — Send screenshots for Claude to analyze, or upload code files for review
- **Access control** — Restrict usage to authorized users via Azure AD object ID or email
- **Per-conversation isolation** — Each chat has its own session, working directory, model, and thinking budget
- **Session persistence** — Conversations survive bot restarts (`.sessions.json`)
- **Slash commands** — `/model`, `/project`, `/thinking`, `/permission`, `/new`, `/status`, `/help`
- **Typing indicators** — Shows "typing..." while Claude is processing
- **Message chunking** — Auto-splits long responses to fit Teams' 25KB limit

## Architecture

```
Teams (any device)
  → Bot Framework SDK
    → Express server (/api/messages)
      → Claude Agent SDK
        → Claude Code (local machine)
```

### Project Structure

```
src/
├── index.ts                 # Express server entry point
├── config.ts                # Env var parsing (app credentials, allowed users)
├── bot/
│   ├── teams-bot.ts         # Main ActivityHandler (auth check, attachments, routing)
│   ├── commands.ts          # Slash command handling
│   ├── attachments.ts       # Download & process Teams file/image attachments
│   ├── mention.ts           # Strip @mentions in group chats
│   └── cards.ts             # Adaptive card builders
├── claude/
│   ├── agent.ts             # Claude Agent SDK integration (text + image support)
│   └── formatter.ts         # Response formatting & message splitting
└── session/
    └── manager.ts           # Per-conversation session persistence
```

### Message Flow

```
1. User sends message in Teams (text, image, or file)
2. Access control check (ALLOWED_USERS whitelist)
3. Process attachments:
   - Images → base64 → Claude vision content block
   - Text/code files → prepend to prompt as code block
   - Unsupported → notify user, skip
4. Route slash commands (if text-only)
5. Start typing indicator loop (3s interval)
6. Call Claude Agent SDK query() with prompt + images
7. Collect session ID, tool usage, and result
8. Format response (tools used + result)
9. Split into chunks, send back to Teams
```

### Attachment Handling

| Type | Action |
|------|--------|
| Images (jpeg, png, gif, webp) | Base64 encode → Claude image content block |
| Text/code files (35+ extensions) | Read as UTF-8 → prepend to prompt as code block |
| Other files | Skip with "unsupported file type" notice |

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
   PORT=3978                          # optional, default 3978
   CLAUDE_WORK_DIR=~/Work             # optional, default ~/Work
   ALLOWED_USERS=                     # optional, comma-separated whitelist
   ```

3. **Start the bot**
   ```bash
   npm run dev
   ```

4. **Upload the Teams app manifest** from `manifest/` to Teams admin center.

5. **Update messaging endpoint** in Azure Bot registration → `<tunnel-url>/api/messages`.

6. **Install as background service**
   ```bash
   npm link          # Register the CLI command
   teams-bot install # Install service + auto-start on login
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
| `/status` | Show current session config |
| `/help` | Show command card |

Any other message is sent to Claude Code as a prompt.

## Service Management

```bash
teams-bot install     # Install + auto-start on login
teams-bot status      # Check if running
teams-bot logs        # Tail logs
teams-bot restart     # Rebuild + restart
teams-bot stop        # Stop service
teams-bot uninstall   # Remove service
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
