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

> **Prerequisites:** Node.js 22+, Claude Code CLI, [Azure Bot registration](docs/azure-bot-setup.md)

```bash
npm install -g claude-code-teams-bot
teams-bot setup            # Interactive config (generates manifest zip)
# Upload teams-claude-bot.zip to Teams (see docs/azure-bot-setup.md)
teams-bot install           # Install as background service
```

**Or install from source:**

```bash
git clone https://github.com/Marvae/teams-claude-bot.git
cd teams-claude-bot
npm install && npm run build
teams-bot setup
teams-bot install
```

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
teams-bot restart           # Restart service
teams-bot status            # Check if running
teams-bot health            # Service status + /healthz probe
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
