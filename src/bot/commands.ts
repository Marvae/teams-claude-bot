import { CardFactory, type TurnContext } from "botbuilder";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import * as state from "../session/state.js";
import { buildHelpCard, buildPermissionModeCard } from "./cards.js";

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const MODEL_SHORTCUTS: Record<string, string> = {
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
  haiku: "claude-haiku-4-5",
};

const AVAILABLE_MODELS = [
  { id: "claude-opus-4-6", shortcut: "opus" },
  { id: "claude-sonnet-4-6", shortcut: "sonnet" },
  { id: "claude-haiku-4-5", shortcut: "haiku" },
];

const VALID_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
];

export async function handleCommand(
  text: string,
  ctx: TurnContext,
): Promise<boolean> {
  if (!text.startsWith("/")) return false;

  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(" ").trim();

  switch (cmd) {
    case "/new":
    case "/clear": {
      state.destroySession();
      state.clearPersistedSessionId();
      await ctx.sendActivity("New session. Send your next message.");
      return true;
    }

    case "/stop":
    case "/cancel": {
      const managed = state.getSession();
      if (managed?.session.hasQuery) {
        await ctx.sendActivity("🛑 Stopping...");
        managed.session.interrupt().catch(() => {});
      } else {
        await ctx.sendActivity("Nothing to interrupt.");
      }
      return true;
    }

    case "/project": {
      if (!arg) {
        await ctx.sendActivity(
          `Current: \`${state.getWorkDir()}\`\n\nUsage: \`/project <path>\``,
        );
        return true;
      }

      const expanded = arg.startsWith("~/")
        ? arg.replace("~", process.env.HOME ?? "~")
        : arg;

      const result = state.setWorkDir(expanded);
      if (!result.ok) {
        await ctx.sendActivity(result.error);
        return true;
      }

      state.destroySession();
      state.clearPersistedSessionId();
      await ctx.sendActivity(
        `Project: \`${state.getWorkDir()}\` (new session)`,
      );
      return true;
    }

    case "/model": {
      if (!arg) {
        const current = state.getModel();
        await ctx.sendActivity(
          current
            ? `Current model: \`${current}\``
            : "No model override set (using default).\n\nUsage: `/model <name>` — e.g. `/model sonnet`",
        );
        return true;
      }

      const resolved = MODEL_SHORTCUTS[arg.toLowerCase()] ?? arg;
      state.setModel(resolved);
      // Update running session dynamically (no restart needed)
      await state.getSession()?.session.setModel(resolved);
      await ctx.sendActivity(`Model set to \`${resolved}\``);
      return true;
    }

    case "/models": {
      const current = state.getModel();
      const lines = AVAILABLE_MODELS.map(
        (m) =>
          `- \`${m.shortcut}\` → \`${m.id}\`${m.id === current ? " (active)" : ""}`,
      );
      await ctx.sendActivity("**Available models:**\n\n" + lines.join("\n"));
      return true;
    }

    case "/thinking": {
      if (!arg) {
        const current = state.getThinkingTokens();
        await ctx.sendActivity(
          current !== undefined && current !== null
            ? `Thinking budget: \`${current}\` tokens`
            : "No thinking budget override set.\n\nUsage: `/thinking <tokens>` or `/thinking off`",
        );
        return true;
      }

      if (arg.toLowerCase() === "off") {
        state.setThinkingTokens(null);
        await ctx.sendActivity("Thinking budget override removed.");
        return true;
      }

      const tokens = parseInt(arg, 10);
      if (isNaN(tokens) || tokens <= 0) {
        await ctx.sendActivity(
          "Invalid value. Usage: `/thinking <number>` or `/thinking off`",
        );
        return true;
      }

      state.setThinkingTokens(tokens);
      await ctx.sendActivity(`Thinking budget set to \`${tokens}\` tokens`);
      return true;
    }

    case "/permission": {
      if (!arg) {
        const current = state.getPermissionMode();
        const card = buildPermissionModeCard(current);
        await ctx.sendActivity({
          attachments: [
            {
              contentType: "application/vnd.microsoft.card.adaptive",
              content: card,
            },
          ],
        });
        return true;
      }

      if (!VALID_PERMISSION_MODES.includes(arg)) {
        await ctx.sendActivity(
          `Invalid mode: \`${arg}\`\n\nValid modes: ${VALID_PERMISSION_MODES.map((m) => `\`${m}\``).join(", ")}`,
        );
        return true;
      }

      state.setPermissionMode(arg);
      await state.getSession()?.session.setPermissionMode(arg);
      await ctx.sendActivity(`Permission mode set to \`${arg}\``);
      return true;
    }
    case "/status": {
      const managed = state.getSession();
      const sessionId = managed?.session.currentSessionId;

      const usage = state.getUsageStats();
      const lines = [
        `**Session:** ${sessionId ? `\`${sessionId.slice(0, 12)}…\`` : "none"}`,
        `**Work dir:** \`${state.getWorkDir()}\``,
        `**Model:** ${state.getModel() ? `\`${state.getModel()}\`` : "default"}`,
        `**Thinking:** ${(() => {
          const t = state.getThinkingTokens();
          return t !== undefined && t !== null ? `\`${t}\` tokens` : "default";
        })()}`,
        `**Permission:** \`${state.getPermissionMode()}\``,
      ];
      if (usage.turns > 0) {
        const tokens = (
          (usage.inputTokens + usage.outputTokens) /
          1000
        ).toFixed(1);
        lines.push(
          `**Usage:** ${usage.turns} turns · ${tokens}k tokens · $${usage.costUsd.toFixed(4)}`,
        );
      }
      await ctx.sendActivity(lines.join("\n\n"));
      return true;
    }

    case "/session": {
      const sub = parts[1]?.toLowerCase();
      if (sub === "name") {
        const title = parts.slice(2).join(" ").trim();
        if (!title) {
          await ctx.sendActivity("Usage: `/session name <title>`");
          return true;
        }
        const currentId = state.getSession()?.session.currentSessionId;
        if (!currentId) {
          await ctx.sendActivity("No active session.");
          return true;
        }
        state.setSessionTitle(currentId, title);
        await ctx.sendActivity(`Session named: **${title}**`);
        return true;
      }
      return false;
    }

    case "/sessions": {
      const currentId = state.getSession()?.session.currentSessionId;
      const MAX_SESSIONS = 8;

      let sdkSessions: Awaited<ReturnType<typeof listSessions>>;
      try {
        sdkSessions = await listSessions({ limit: MAX_SESSIONS });
        sdkSessions.sort((a, b) => b.lastModified - a.lastModified);
      } catch {
        await ctx.sendActivity(
          "Could not list sessions. Start chatting to create one.",
        );
        return true;
      }

      if (sdkSessions.length === 0) {
        await ctx.sendActivity("No sessions. Start chatting to create one.");
        return true;
      }

      const bodyItems: unknown[] = [
        {
          type: "TextBlock",
          text: "Sessions",
          weight: "bolder",
          size: "medium",
        },
      ];
      const actions: unknown[] = [];

      let num = 0;
      for (const s of sdkSessions) {
        num++;
        const isActive = s.sessionId === currentId;
        const label = state.getBotTitle(s.sessionId) || s.customTitle || s.summary || "Untitled";
        const age = formatAge(new Date(s.lastModified).toISOString());
        const dirName = s.cwd?.split("/").pop() ?? "";
        const meta = [dirName ? `${dirName}` : null, age, s.gitBranch ?? null]
          .filter(Boolean)
          .join(" · ");

        const prefix = isActive ? "▶ " : `#${num} `;
        bodyItems.push({
          type: "TextBlock",
          text: `${prefix}**${label}**`,
          spacing: "small",
          wrap: true,
        });
        bodyItems.push({
          type: "TextBlock",
          text: `    ${meta}`,
          spacing: "none",
          size: "small",
          isSubtle: true,
        });

        if (!isActive) {
          actions.push({
            type: "Action.Submit",
            title: `#${num}`,
            data: {
              action: "resume_session",
              sessionId: s.sessionId,
              cwd: s.cwd,
            },
          });
        }
      }

      const card = CardFactory.adaptiveCard({
        type: "AdaptiveCard",
        version: "1.4",
        body: bodyItems,
        actions,
      });

      await ctx.sendActivity({ attachments: [card] });
      return true;
    }

    case "/handoff": {
      if (arg === "back") {
        const mode = state.getHandoffMode();
        const sessionId = state.getSession()?.session.currentSessionId;

        if (!mode && !sessionId) {
          await ctx.sendActivity("No active handoff to hand back.");
          return true;
        }

        state.clearHandoffMode();
        await ctx.sendActivity(
          "Handed back. Your Terminal session is still active.\n\nYou can keep working here.",
        );
      } else {
        await ctx.sendActivity(
          "**Handoff commands:**\n\n" +
            `\`/handoff back\` — hand session back to Terminal`,
        );
      }
      return true;
    }

    case "/undo": {
      const managed = state.getSession();
      if (!managed) {
        await ctx.sendActivity("No active session.");
        return true;
      }

      const history = managed.session.getUndoHistory();
      if (history.length === 0) {
        await ctx.sendActivity("Nothing to undo.");
        return true;
      }

      // No arg → show history
      if (!arg) {
        const lines = history.map(
          (h, i) => `${i + 1}. ${h.preview || "(no text)"}`,
        );
        await ctx.sendActivity(
          "**Recent turns:**\n\n" +
            lines.join("\n") +
            "\n\nReply `/undo 1` to revert last turn, `/undo 3` to revert last 3 turns.",
        );
        return true;
      }

      const n = parseInt(arg, 10);
      if (isNaN(n) || n < 1 || n > history.length) {
        await ctx.sendActivity(
          `Invalid. Use \`/undo 1\` to \`/undo ${history.length}\`.`,
        );
        return true;
      }

      // Rewind to the nth most recent user message
      const target = history[n - 1];
      const result = await managed.session.rewindFiles(target.uuid);

      if (!result.canRewind) {
        await ctx.sendActivity(result.error ?? "Nothing to undo.");
        return true;
      }

      const files = result.filesChanged?.length ?? 0;
      const ins = result.insertions ?? 0;
      const del = result.deletions ?? 0;
      await ctx.sendActivity(
        `Undo complete — reverted ${files} file${files !== 1 ? "s" : ""} (+${ins} / -${del})`,
      );
      return true;
    }

    case "/help": {
      const managed = state.getSession();
      let sdkCommands = await managed?.session.getSupportedCommands();
      if (sdkCommands && sdkCommands.length > 0) {
        state.setCachedCommands(sdkCommands);
      } else {
        sdkCommands = state.getCachedCommands();
      }
      const card = buildHelpCard(sdkCommands);
      await ctx.sendActivity({
        attachments: [CardFactory.adaptiveCard(card)],
      });
      return true;
    }

    default: {
      // Unknown bot command — forward to SDK as a slash command
      return false;
    }
  }
}
