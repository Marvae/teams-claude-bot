# Claude Code Teams Bot

A Microsoft Teams bot that bridges to Claude Code on your local machine. Chat with Claude Code from any device — phone, tablet, or another PC.

## Features

- **Full Claude Code access** — all tools (Read, Write, Edit, Bash, etc.) via Teams
- **Streaming responses** — real-time progress with live text, diffs, and todo tracking
- **Image & file upload** — screenshots, code files, drag-and-drop
- **Handoff** — seamless Terminal ↔ Teams session handoff with `/handoff`
- **Session management** — long-lived sessions, auto-resume, `/sessions` browser
- **Permission control** — dynamic modes via Adaptive Cards (Default, Plan, Don't Ask, etc.)
- **Access control** — Azure AD whitelist, rate limiting, security headers

## Architecture

```
Teams (any device)
  → Bot Framework SDK (botbuilder v4)
    → Express server
      → Claude Agent SDK (streaming input mode)
        → Claude Code (local machine)
```

- **TypeScript** — strict mode, ESM, Node.js 22+
- **esbuild** — single-file bundle
- **vitest** — testing (cross-platform CI on macOS, Linux, Windows)

## Quick Start

```bash
npm install -g teams-claude-bot
teams-bot setup            # Interactive config
teams-bot install           # Install as background service
teams-bot install-skill     # Enable /handoff in Claude Code
```

> **Prerequisites:** Node.js 22+, Claude Code CLI, [Azure Bot registration](docs/azure-bot-setup.md)

## From Source

```bash
git clone <repo-url> && cd teams-claude-bot && npm install
teams-bot setup            # Or: cp .env.example .env
npm run dev                # Hot reload + tunnel
```

Then upload `manifest/` to Teams and set the messaging endpoint in Azure Bot to `<tunnel-url>/api/messages`.

## Commands

| Command | Description |
|---------|-------------|
| `/new` | Start a fresh session |
| `/stop` | Interrupt current task |
| `/project <path>` | Set working directory |
| `/model [name]` | Set model (sonnet/opus/haiku) |
| `/permission [mode]` | Set permission mode |
| `/sessions` | Browse and resume past sessions |
| `/handoff` | Hand off to/from Terminal |
| `/status` | Session info + usage stats |
| `/help` | Show all commands |

Any other `/command` is forwarded to Claude Code. Any other message is a prompt.

## Handoff (Terminal ↔ Teams)

Install the `/handoff` skill for Claude Code:

```bash
teams-bot install-skill
```

Then in any Claude Code session, run `/handoff` to send the current session to Teams. A confirmation card appears in Teams — click Accept to fork the session. Both sides continue independently on the same codebase.

In Teams, send `/handoff back` to clear handoff mode.

## Service Management

```bash
teams-bot setup            # Interactive config
teams-bot install           # Install + auto-start
teams-bot start / stop      # Start or stop service
teams-bot restart           # Rebuild + restart
teams-bot status            # Check if running
teams-bot logs              # Tail logs
teams-bot install-skill     # Install /handoff for Claude Code
teams-bot uninstall-skill   # Remove /handoff
teams-bot uninstall         # Remove service
```

## Development

```bash
npm run dev          # Hot reload + tunnel
npm test             # Run tests
npm run build        # Production build
npm run lint         # ESLint
```
