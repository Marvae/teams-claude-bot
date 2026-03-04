#!/bin/bash
# teams-claude-bot service control

LABEL="com.teams-claude-bot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/teams-claude-bot.log"
SCRIPT="$(readlink -f "$0" 2>/dev/null || python3 -c "import os; print(os.path.realpath('$0'))")"
PROJECT_DIR="$(cd "$(dirname "$SCRIPT")/.." && pwd)"

case "$1" in
  install)
    # Build first
    cd "$PROJECT_DIR" && npm run build

    # Ask about diff rendering feature
        read -p "Enable diff image rendering? (requires ~200MB download) [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      echo "Installing diff rendering dependencies..."
      npm install @pierre/diffs playwright-core
      npx playwright install chromium || echo "Warning: playwright install failed, diff images disabled"
    fi

    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PROJECT_DIR/scripts/run.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${PATH}</string>
    </dict>
</dict>
</plist>
PLIST

    launchctl load "$PLIST"
    echo "Installed and started. Logs: $LOG"

    # Check if conversation reference exists
    if [ ! -f "$PROJECT_DIR/.conversation-refs.json" ] || [ "$(cat "$PROJECT_DIR/.conversation-refs.json" 2>/dev/null)" = "{}" ]; then
      echo ""
      echo -e "\033[33m⚠️  Important: Send any message to the bot in Teams to activate handoff.\033[0m"
      echo "   This is a one-time setup — the bot needs to know your conversation ID."
    fi

    echo ""
    read -p "Install /handoff skill for Claude Code? [Y/n]: " INSTALL_SKILL
    INSTALL_SKILL="${INSTALL_SKILL:-Y}"
    if [[ "$INSTALL_SKILL" =~ ^[Yy]$ ]]; then
      "$0" install-skill
    else
      echo "Tip: Run '$0 install-skill' later to enable /handoff."
    fi
    ;;

  uninstall)
    launchctl unload "$PLIST" 2>/dev/null
    rm -f "$PLIST"
    echo "Uninstalled. Run '$0 uninstall-skill' to remove /handoff skill."
    ;;

  start)
    launchctl start "$LABEL"
    echo "Started."
    ;;

  stop)
    launchctl stop "$LABEL"
    echo "Stopped."
    ;;

  restart)
    launchctl stop "$LABEL"
    sleep 1
    cd "$PROJECT_DIR" && npm run build
    launchctl start "$LABEL"
    echo "Restarted."
    ;;

  status)
    if launchctl list "$LABEL" &>/dev/null; then
      PID=$(launchctl list "$LABEL" | grep PID | awk '{print $3}')
      if [ -n "$PID" ] && [ "$PID" != "-" ]; then
        echo "Running (PID: $PID)"
      else
        echo "Loaded but not running"
      fi
    else
      echo "Not installed"
    fi
    ;;

  logs)
    tail -f "$LOG"
    ;;

  build)
    cd "$PROJECT_DIR" && npm run build
    echo "Built. Run '$0 restart' to apply."
    ;;

  install-skill)
    SKILL_SRC="$PROJECT_DIR/.claude/skills/handoff/SKILL.md"
    if [ ! -f "$SKILL_SRC" ]; then
      echo "Error: Skill file not found at $SKILL_SRC"
      exit 1
    fi

    if ! command -v jq &>/dev/null; then
      echo "Error: jq is required. Install with: brew install jq"
      exit 1
    fi

    BOLD='\033[1m'
    DIM='\033[2m'
    GREEN='\033[32m'
    CYAN='\033[36m'
    RESET='\033[0m'

    echo ""
    echo -e "${BOLD}Teams Bot - Install /handoff${RESET}"
    echo ""

    # 1. Scope (skill + hook together)
    echo -e "${CYAN}Where to install?${RESET}"
    echo "  1) Global (all projects)    ${DIM}~/.claude/${RESET}"
    echo "  2) This project only        ${DIM}.claude/${RESET}"
    echo ""
    read -p "Choose [1]: " SCOPE_CHOICE
    SCOPE_CHOICE="${SCOPE_CHOICE:-1}"

    # 2. Bot URL
    echo ""
    echo -e "${CYAN}Teams Bot URL?${RESET}"
    read -p "URL [http://localhost:3978]: " BOT_URL
    BOT_URL="${BOT_URL:-http://localhost:3978}"

    # Summary
    echo ""
    echo -e "${BOLD}Summary:${RESET}"
    if [ "$SCOPE_CHOICE" = "1" ]; then
      echo "  Install to: ~/.claude/ (global)"
    else
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

    if [ "$SCOPE_CHOICE" = "1" ]; then
      SETTINGS_FILE="$HOME/.claude/settings.json"
      SKILL_DIR="$HOME/.claude/skills/handoff"
      mkdir -p "$SKILL_DIR"
      ln -sf "$SKILL_SRC" "$SKILL_DIR/SKILL.md"
      echo -e "${GREEN}✓${RESET} Skill installed"
    else
      SETTINGS_FILE="$PROJECT_DIR/.claude/settings.json"
      echo -e "${GREEN}✓${RESET} Skill in project .claude/skills/"
    fi

    # Install SessionStart hook (uses script file to avoid escaping issues)
    HOOK_SCRIPT="$PROJECT_DIR/.claude/hooks/session-start.sh"
    chmod +x "$HOOK_SCRIPT" 2>/dev/null

    [ ! -f "$SETTINGS_FILE" ] && echo '{}' > "$SETTINGS_FILE"

    if jq -e '.hooks.SessionStart[]?.hooks[]? | select(.command | contains("session-start.sh"))' "$SETTINGS_FILE" &>/dev/null; then
      echo -e "${GREEN}✓${RESET} Hook already configured"
    else
      jq --arg cmd "$HOOK_SCRIPT" '
        .hooks //= {} |
        .hooks.SessionStart //= [] |
        .hooks.SessionStart += [{
          "hooks": [{
            "type": "command",
            "command": $cmd
          }]
        }]
      ' "$SETTINGS_FILE" > "$SETTINGS_FILE.tmp" && mv "$SETTINGS_FILE.tmp" "$SETTINGS_FILE"
      echo -e "${GREEN}✓${RESET} Hook installed"
    fi

    # Save or clean bot URL
    if [ "$BOT_URL" != "http://localhost:3978" ]; then
      jq --arg url "$BOT_URL" '.env.TEAMS_BOT_URL = $url' "$SETTINGS_FILE" > "$SETTINGS_FILE.tmp" && mv "$SETTINGS_FILE.tmp" "$SETTINGS_FILE"
      echo -e "${GREEN}✓${RESET} Bot URL saved"
    else
      # Clean up any previously set custom URL
      if jq -e '.env.TEAMS_BOT_URL' "$SETTINGS_FILE" &>/dev/null; then
        jq 'del(.env.TEAMS_BOT_URL)' "$SETTINGS_FILE" > "$SETTINGS_FILE.tmp" && mv "$SETTINGS_FILE.tmp" "$SETTINGS_FILE"
      fi
    fi

    echo ""
    echo -e "${BOLD}Done!${RESET} Restart Claude Code, then use /handoff."
    ;;

  uninstall-skill)
    # Remove skill from both locations
    rm -rf "$HOME/.claude/skills/handoff"

    # Remove hook from both locations
    for SETTINGS_FILE in "$HOME/.claude/settings.json" ".claude/settings.json"; do
      if [ -f "$SETTINGS_FILE" ] && command -v jq &>/dev/null; then
        if jq -e '.hooks.SessionStart[]?.hooks[]? | select(.command | contains("session-start.sh"))' "$SETTINGS_FILE" &>/dev/null; then
          jq '
            if .hooks.SessionStart then
              .hooks.SessionStart |= map(
                .hooks |= map(select(.command | contains("session-start.sh") | not))
              ) |
              .hooks.SessionStart |= map(select(.hooks | length > 0)) |
              if (.hooks.SessionStart | length) == 0 then del(.hooks.SessionStart) else . end |
              if (.hooks | length) == 0 then del(.hooks) else . end
            else . end
          ' "$SETTINGS_FILE" > "$SETTINGS_FILE.tmp" && mv "$SETTINGS_FILE.tmp" "$SETTINGS_FILE"
          echo "Removed hook from $SETTINGS_FILE"
        fi
      fi
    done

    echo "Uninstalled /handoff skill and hook."
    ;;

  enable-diff)
    echo "Installing diff rendering dependencies..."
    npm install @pierre/diffs playwright-core
    npx playwright install chromium
    echo "Done. Diff images are now enabled."
    ;;

  *)
    echo "Usage: $0 {install|uninstall|start|stop|restart|status|logs|build|install-skill|uninstall-skill|enable-diff}"
    ;;
esac
