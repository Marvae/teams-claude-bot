import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import { MessageActivity } from "@microsoft/teams.api";
import type { ActivityLike, SentActivity } from "@microsoft/teams.api";
import type { IAdaptiveCard } from "@microsoft/teams.cards";
import {
  TextBlock,
  ChoiceSetInput,
  Choice,
  ExecuteAction,
} from "@microsoft/teams.cards";
import * as state from "../session/state.js";
import {
  adaptiveCard,
  buildHelpCard,
  buildPermissionModeCard,
} from "./cards.js";

/** Minimal context interface matching Teams SDK's IActivityContext. */
export interface CommandContext {
  send(activity: ActivityLike): Promise<SentActivity>;
}

/** Send an Adaptive Card as a MessageActivity. */
function sendCard(ctx: CommandContext, card: IAdaptiveCard) {
  return ctx.send(new MessageActivity().addCard("adaptive", card));
}

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
  "auto",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
];

export async function handleCommand(
  text: string,
  ctx: CommandContext,
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
      await ctx.send("New session. Send your next message.");
      return true;
    }

    case "/stop":
    case "/cancel": {
      const managed = state.getSession();
      if (managed?.session.hasQuery) {
        await ctx.send("🛑 Stopping...");
        managed.session.interrupt().catch(() => {});
      } else {
        await ctx.send("Nothing to interrupt.");
      }
      return true;
    }

    case "/project": {
      if (!arg) {
        await ctx.send(
          `Current: \`${state.getWorkDir()}\`\n\nUsage: \`/project <path>\``,
        );
        return true;
      }

      const expanded = arg.startsWith("~/")
        ? arg.replace("~", process.env.HOME ?? "~")
        : arg;

      const result = state.setWorkDir(expanded);
      if (!result.ok) {
        await ctx.send(result.error);
        return true;
      }

      state.destroySession();
      state.clearPersistedSessionId();
      await ctx.send(`Project: \`${state.getWorkDir()}\` (new session)`);
      return true;
    }

    case "/model": {
      if (!arg) {
        const current = state.getModel();
        await ctx.send(
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
      await ctx.send(`Model set to \`${resolved}\``);
      return true;
    }

    case "/models": {
      const current = state.getModel();
      const lines = AVAILABLE_MODELS.map(
        (m) =>
          `- \`${m.shortcut}\` → \`${m.id}\`${m.id === current ? " (active)" : ""}`,
      );
      await ctx.send("**Available models:**\n\n" + lines.join("\n"));
      return true;
    }

    case "/thinking": {
      if (!arg) {
        const current = state.getThinkingTokens();
        await ctx.send(
          current !== undefined && current !== null
            ? `Thinking budget: \`${current}\` tokens`
            : "No thinking budget override set.\n\nUsage: `/thinking <tokens>` or `/thinking off`",
        );
        return true;
      }

      if (arg.toLowerCase() === "off") {
        state.setThinkingTokens(null);
        await ctx.send("Thinking budget override removed.");
        return true;
      }

      const tokens = parseInt(arg, 10);
      if (isNaN(tokens) || tokens <= 0) {
        await ctx.send(
          "Invalid value. Usage: `/thinking <number>` or `/thinking off`",
        );
        return true;
      }

      state.setThinkingTokens(tokens);
      await ctx.send(`Thinking budget set to \`${tokens}\` tokens`);
      return true;
    }

    case "/permission": {
      if (!arg) {
        const current = state.getPermissionMode();
        const card = buildPermissionModeCard(current);
        await sendCard(ctx, card);
        return true;
      }

      if (!VALID_PERMISSION_MODES.includes(arg)) {
        await ctx.send(
          `Invalid mode: \`${arg}\`\n\nValid modes: ${VALID_PERMISSION_MODES.map((m) => `\`${m}\``).join(", ")}`,
        );
        return true;
      }

      state.setPermissionMode(arg);
      await state.getSession()?.session.setPermissionMode(arg);
      await ctx.send(`Permission mode set to \`${arg}\``);
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
      await ctx.send(lines.join("\n\n"));
      return true;
    }

    case "/session": {
      const sub = parts[1]?.toLowerCase();
      if (sub === "name") {
        const title = parts.slice(2).join(" ").trim();
        if (!title) {
          await ctx.send("Usage: `/session name <title>`");
          return true;
        }
        const currentId = state.getSession()?.session.currentSessionId;
        if (!currentId) {
          await ctx.send("No active session.");
          return true;
        }
        state.setSessionTitle(currentId, title);
        await ctx.send(`Session named: **${title}**`);
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
        await ctx.send(
          "Could not list sessions. Start chatting to create one.",
        );
        return true;
      }

      if (sdkSessions.length === 0) {
        await ctx.send("No sessions. Start chatting to create one.");
        return true;
      }

      // Build a lookup of sessionId -> cwd for the submit handler
      const sessionCwds: Record<string, string | undefined> = {};
      const choices = sdkSessions.map((s) => {
        sessionCwds[s.sessionId] = s.cwd;
        const label =
          state.getBotTitle(s.sessionId) ||
          s.customTitle ||
          s.summary ||
          "Untitled";
        const age = formatAge(new Date(s.lastModified).toISOString());
        const dirName = s.cwd?.split("/").pop() ?? "";
        const meta = [dirName ? `${dirName}` : null, age, s.gitBranch ?? null]
          .filter(Boolean)
          .join(" · ");

        return {
          title: meta ? `${label} (${meta})` : label,
          value: s.sessionId,
        };
      });

      const sdkChoices = choices.map(
        (c) => new Choice({ title: c.title, value: c.value }),
      );

      const card = adaptiveCard(
        new TextBlock("Sessions", { weight: "Bolder", size: "Medium" }),
        new ChoiceSetInput(...sdkChoices).withOptions({
          id: "sessionId",
          style: "expanded",
          value: currentId ?? sdkSessions[0].sessionId,
        }),
      );
      card.actions = [
        new ExecuteAction({
          title: "Submit",
          style: "positive",
          data: { action: "resume_session", sessionCwds },
        }),
        new ExecuteAction({
          title: "Cancel",
          data: { action: "noop" },
        }),
      ];

      await sendCard(ctx, card);
      return true;
    }

    case "/handoff": {
      if (arg === "back") {
        const mode = state.getHandoffMode();
        const sessionId = state.getSession()?.session.currentSessionId;

        if (!mode && !sessionId) {
          await ctx.send("No active handoff to hand back.");
          return true;
        }

        state.clearHandoffMode();
        await ctx.send(
          "Handed back. Your Terminal session is still active.\n\nYou can keep working here.",
        );
      } else {
        await ctx.send(
          "**Handoff commands:**\n\n" +
            `\`/handoff back\` — hand session back to Terminal`,
        );
      }
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
      await sendCard(ctx, card);
      return true;
    }

    default: {
      // Unknown bot command — forward to SDK as a slash command
      return false;
    }
  }
}
