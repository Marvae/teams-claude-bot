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
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
PLIST

    launchctl load "$PLIST"
    echo "Installed and started. Logs: $LOG"
    echo "Tip: Run '$0 install-skill' to enable /handoff in Claude Code"
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
    SKILL_DST="$HOME/.claude/commands/handoff.md"
    if [ ! -f "$SKILL_SRC" ]; then
      echo "Error: Skill file not found at $SKILL_SRC"
      exit 1
    fi
    mkdir -p "$HOME/.claude/commands"
    ln -sf "$SKILL_SRC" "$SKILL_DST"
    echo "Installed /handoff skill. Use /handoff in any Claude Code session."
    ;;

  uninstall-skill)
    rm -f "$HOME/.claude/commands/handoff.md"
    echo "Removed /handoff skill."
    ;;

  *)
    echo "Usage: $0 {install|uninstall|start|stop|restart|status|logs|build|install-skill|uninstall-skill}"
    ;;
esac
