#!/bin/bash
# teams-claude-bot Windows control script (Git Bash)
# Usage: bash scripts/ctl-win.sh {install|uninstall|start|stop|restart|status|logs|install-skill|uninstall-skill}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR_WIN="$(cd "$PROJECT_DIR" && pwd -W 2>/dev/null || echo "$PROJECT_DIR")"
LOG_FILE="$PROJECT_DIR/teams-bot.log"
TASK_NAME="TeamsClaudeBot"
BASH_EXE="$(which bash)"
BASH_EXE_WIN="$(cygpath -w "$BASH_EXE" 2>/dev/null || echo "$BASH_EXE")"

_is_running() {
  netstat -ano 2>/dev/null | grep -q ":3978.*LISTENING"
}

_stop() {
  powershell -Command "
    (Get-NetTCPConnection -LocalPort 3978 -ErrorAction SilentlyContinue).OwningProcess |
      Select-Object -Unique |
      ForEach-Object { Stop-Process -Id \$_ -Force -ErrorAction SilentlyContinue }
    Get-Process devtunnel -ErrorAction SilentlyContinue | Stop-Process -Force
  " 2>/dev/null || true
}

_task_exists() {
  powershell -Command "
    if (Get-ScheduledTask -TaskName '$TASK_NAME' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }
  " 2>/dev/null
}

_start_bg() {
  # Start bot + tunnel as a hidden background process, logging to file
  powershell -Command "
    Start-Process -FilePath '$BASH_EXE_WIN' \
      -ArgumentList '$PROJECT_DIR_WIN/scripts/run.sh' \
      -WindowStyle Hidden \
      -RedirectStandardOutput '$PROJECT_DIR_WIN\teams-bot.log' \
      -RedirectStandardError '$PROJECT_DIR_WIN\teams-bot-err.log'
  " 2>/dev/null
}

case "${1:-help}" in

  # ── Service management ──────────────────────────────────────────────────────

  install)
    echo "Building..."
    cd "$PROJECT_DIR" && npm run build

    # Ask about diff rendering feature
        read -p "Enable diff image rendering? (requires ~200MB download) [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      echo "Installing diff rendering dependencies..."
      npm install @pierre/diffs playwright-core
      npx playwright install chromium || echo "Warning: playwright install failed, diff images disabled"
    fi

    _stop 2>/dev/null

    echo "Starting background service..."
    [ -f "$LOG_FILE" ] && mv "$LOG_FILE" "${LOG_FILE}.old"
    _start_bg

    echo "Registering auto-start on login (Task Scheduler)..."
    powershell -Command "
      \$action = New-ScheduledTaskAction \
        -Execute '$BASH_EXE_WIN' \
        -Argument '\"$PROJECT_DIR_WIN/scripts/run.sh\"' \
        -WorkingDirectory '$PROJECT_DIR_WIN'
      \$trigger = New-ScheduledTaskTrigger -AtLogOn -User \$env:USERNAME
      \$settings = New-ScheduledTaskSettingsSet \
        -ExecutionTimeLimit 0 \
        -RestartCount 3 \
        -RestartInterval (New-TimeSpan -Minutes 1)
      Register-ScheduledTask \
        -TaskName '$TASK_NAME' \
        -Action \$action \
        -Trigger \$trigger \
        -Settings \$settings \
        -Force | Out-Null
      Write-Host 'Auto-start registered.'
    "

    echo ""
    echo "Installed. Logs: $LOG_FILE"
    echo "Use 'teams-bot-win logs' to follow logs."
    echo ""

    # Prompt to install-skill too
    read -p "Install /handoff skill for Claude Code? [Y/n]: " INSTALL_SKILL
    INSTALL_SKILL="${INSTALL_SKILL:-Y}"
    if [[ "$INSTALL_SKILL" =~ ^[Yy]$ ]]; then
      exec "$0" install-skill
    fi
    ;;

  uninstall)
    echo "Stopping..."
    _stop

    echo "Removing Task Scheduler task..."
    powershell -Command "
      Unregister-ScheduledTask -TaskName '$TASK_NAME' -Confirm:\$false -ErrorAction SilentlyContinue
      Write-Host 'Task removed.'
    "
    echo "Uninstalled. Run 'teams-bot-win uninstall-skill' to also remove /handoff."
    ;;

  start)
    # Dev mode: visible window with hot reload (no build needed)
    if _is_running; then
      echo "Bot already running on port 3978. Use 'restart' to restart."
      exit 0
    fi
    echo "Starting teams-bot (dev mode)..."
    powershell -Command "Start-Process cmd -ArgumentList '/k','npm run dev' -WorkingDirectory '$PROJECT_DIR_WIN'"
    echo "Bot starting in new window."
    ;;

  stop)
    echo "Stopping..."
    _stop
    echo "Stopped."
    ;;

  restart)
    echo "Stopping..."
    _stop
    sleep 1

    echo "Building..."
    cd "$PROJECT_DIR" && npm run build

    # Always restart as background service with log file
    echo "Starting background service..."
    [ -f "$LOG_FILE" ] && mv "$LOG_FILE" "${LOG_FILE}.old"
    _start_bg
    echo "Restarted. Logs: $LOG_FILE"
    echo "Use 'teams-bot-win logs' to follow logs."
    ;;

  status)
    if _is_running; then
      PID=$(powershell -Command \
        "(Get-NetTCPConnection -LocalPort 3978 -ErrorAction SilentlyContinue).OwningProcess | Select-Object -First 1" \
        2>/dev/null | tr -d '[:space:]')
      echo "Running (port 3978, PID: $PID)"
    else
      echo "Not running"
    fi

    if _task_exists; then
      echo "Auto-start: enabled (Task Scheduler: $TASK_NAME)"
    else
      echo "Auto-start: not configured"
    fi
    ;;

  logs)
    ERR_LOG="${LOG_FILE%.log}-err.log"
    if [ -f "$LOG_FILE" ] || [ -f "$ERR_LOG" ]; then
      # Merge stdout + stderr logs in real time
      tail -f "$LOG_FILE" "$ERR_LOG" 2>/dev/null
    else
      echo "No log file at: $LOG_FILE"
      echo "Tip: Use 'teams-bot-win restart' to start the service, then re-run logs."
    fi
    ;;

  # ── Skill management ────────────────────────────────────────────────────────

  install-skill)
    SKILL_SRC="$PROJECT_DIR/.claude/skills/handoff/SKILL.md"
    GET_SID_SRC="$PROJECT_DIR/.claude/skills/handoff/get-session-id.sh"
    SESSION_HOOK="$PROJECT_DIR/.claude/hooks/session-start.sh"

    if [ ! -f "$SKILL_SRC" ]; then
      echo "Error: Skill file not found at $SKILL_SRC"
      exit 1
    fi

    echo ""
    echo "Teams Bot - Install /handoff"
    echo ""
    echo "Where to install?"
    echo "  1) Global (all projects)   ~/.claude/"
    echo "  2) This project only       .claude/"
    echo ""
    read -p "Choose [1]: " SCOPE_CHOICE
    SCOPE_CHOICE="${SCOPE_CHOICE:-1}"

    echo ""
    read -p "Teams Bot URL [http://localhost:3978]: " BOT_URL
    BOT_URL="${BOT_URL:-http://localhost:3978}"

    echo ""

    if [ "$SCOPE_CHOICE" = "1" ]; then
      SETTINGS_FILE="$HOME/.claude/settings.json"
      SKILL_DEST="$HOME/.claude/skills/handoff"
      echo "  Install to: ~/.claude/ (global)"
    else
      SETTINGS_FILE="$PROJECT_DIR/.claude/settings.json"
      SKILL_DEST="$PROJECT_DIR/.claude/skills/handoff"
      echo "  Install to: .claude/ (project)"
    fi
    echo "  Bot URL:    $BOT_URL"
    echo ""
    read -p "Proceed? [Y/n]: " CONFIRM
    CONFIRM="${CONFIRM:-Y}"
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
      echo "Cancelled."
      exit 0
    fi
    echo ""

    # Copy skill files (symlinks need admin on Windows, use copy instead)
    mkdir -p "$SKILL_DEST"
    cp "$SKILL_SRC" "$SKILL_DEST/SKILL.md"
    cp "$GET_SID_SRC" "$SKILL_DEST/get-session-id.sh"
    chmod +x "$SKILL_DEST/get-session-id.sh"
    echo "✓ Skill installed"

    # Hook path in Windows format (Claude Code on Windows expects this)
    HOOK_PATH_WIN="$(cd "$(dirname "$SESSION_HOOK")" && pwd -W)/$(basename "$SESSION_HOOK")"
    chmod +x "$SESSION_HOOK" 2>/dev/null

    [ ! -f "$SETTINGS_FILE" ] && echo '{}' > "$SETTINGS_FILE"

    # Use Python to update settings.json (replaces jq)
    python3 - "$SETTINGS_FILE" "$HOOK_PATH_WIN" "$BOT_URL" <<'PYEOF'
import sys, json

settings_file, hook_cmd, bot_url = sys.argv[1], sys.argv[2], sys.argv[3]
# Normalize to forward slashes (consistent with existing settings.json style)
hook_cmd = hook_cmd.replace('\\', '/')

with open(settings_file, 'r') as f:
    data = json.load(f)

# Add hook if not already present
already = any(
    'session-start.sh' in h.get('command', '')
    for group in data.get('hooks', {}).get('SessionStart', [])
    for h in group.get('hooks', [])
)
if not already:
    data.setdefault('hooks', {}).setdefault('SessionStart', []).append(
        {'hooks': [{'type': 'command', 'command': hook_cmd}]}
    )
    print('✓ Hook installed')
else:
    print('✓ Hook already configured')

# Save bot URL (only if non-default)
if bot_url != 'http://localhost:3978':
    data.setdefault('env', {})['TEAMS_BOT_URL'] = bot_url
    print(f'✓ Bot URL saved: {bot_url}')
else:
    data.get('env', {}).pop('TEAMS_BOT_URL', None)

with open(settings_file, 'w') as f:
    json.dump(data, f, indent=2)
PYEOF

    echo ""
    echo "Done! Restart Claude Code, then use /handoff."
    ;;

  uninstall-skill)
    REMOVED=0
    for SETTINGS_FILE in "$HOME/.claude/settings.json" "$PROJECT_DIR/.claude/settings.json"; do
      [ -f "$SETTINGS_FILE" ] || continue

      python3 - "$SETTINGS_FILE" <<'PYEOF'
import sys, json

settings_file = sys.argv[1]
with open(settings_file, 'r') as f:
    data = json.load(f)

if 'SessionStart' not in data.get('hooks', {}):
    sys.exit(0)

groups = [
    {**g, 'hooks': [h for h in g.get('hooks', []) if 'session-start.sh' not in h.get('command', '')]}
    for g in data['hooks']['SessionStart']
]
groups = [g for g in groups if g.get('hooks')]

if groups:
    data['hooks']['SessionStart'] = groups
else:
    del data['hooks']['SessionStart']
    if not data.get('hooks'):
        data.pop('hooks', None)

with open(settings_file, 'w') as f:
    json.dump(data, f, indent=2)
print(f'✓ Hook removed from {settings_file}')
PYEOF
      REMOVED=1
    done

    rm -rf "$HOME/.claude/skills/handoff"
    echo "✓ Skill removed"
    echo "Uninstalled /handoff skill and hook."
    ;;

  # ── Help ────────────────────────────────────────────────────────────────────

  *)
    echo "Usage: $0 <command>"
    echo ""
    echo "  install           Build + start as background service + auto-start on login"
    echo "  uninstall         Stop service + remove auto-start"
    echo "  start             Start in new terminal window (dev mode)"
    echo "  stop              Stop bot and tunnel"
    echo "  restart           Rebuild + restart"
    echo "  status            Check if running"
    echo "  logs              Tail log file (install mode only)"
    echo "  install-skill     Install /handoff skill for Claude Code"
    echo "  uninstall-skill   Remove /handoff skill"
    echo "  enable-diff       Install playwright for diff image rendering"
    ;;

  enable-diff)
    echo "Installing diff rendering dependencies..."
    npm install @pierre/diffs playwright-core
    npx playwright install chromium
    echo "Done. Diff images are now enabled."
    ;;
esac
