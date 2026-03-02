import { CardFactory, type TurnContext } from "botbuilder";
import {
  clearSession,
  getSession,
  getWorkDir,
  setWorkDir,
  getModel,
  setModel,
  getThinkingTokens,
  setThinkingTokens,
  getPermissionMode,
  setPermissionMode,
} from "../session/manager.js";
import { buildHelpCard } from "./cards.js";

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

const VALID_PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions"];

export async function handleCommand(
  text: string,
  conversationId: string,
  ctx: TurnContext,
): Promise<boolean> {
  if (!text.startsWith("/")) return false;

  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(" ").trim();

  switch (cmd) {
    case "/new":
    case "/clear": {
      clearSession(conversationId);
      await ctx.sendActivity("New session. Send your next message.");
      return true;
    }

    case "/compact": {
      clearSession(conversationId);
      await ctx.sendActivity(
        "Session cleared. Context will be managed fresh.",
      );
      return true;
    }

    case "/project": {
      if (!arg) {
        const wd = getWorkDir(conversationId);
        await ctx.sendActivity(
          `Current: \`${wd}\`\n\nUsage: \`/project <path>\``,
        );
        return true;
      }

      const expanded = arg.startsWith("~/")
        ? arg.replace("~", process.env.HOME ?? "~")
        : arg;

      const result = setWorkDir(conversationId, expanded);
      if (!result.ok) {
        await ctx.sendActivity(result.error);
        return true;
      }

      clearSession(conversationId);
      await ctx.sendActivity(
        `Project: \`${getWorkDir(conversationId)}\` (new session)`,
      );
      return true;
    }

    case "/model": {
      if (!arg) {
        const current = getModel(conversationId);
        await ctx.sendActivity(
          current
            ? `Current model: \`${current}\``
            : "No model override set (using default).\n\nUsage: `/model <name>` — e.g. `/model sonnet`",
        );
        return true;
      }

      const resolved = MODEL_SHORTCUTS[arg.toLowerCase()] ?? arg;
      setModel(conversationId, resolved);
      await ctx.sendActivity(`Model set to \`${resolved}\``);
      return true;
    }

    case "/models": {
      const current = getModel(conversationId);
      const lines = AVAILABLE_MODELS.map(
        (m) =>
          `- \`${m.shortcut}\` → \`${m.id}\`${m.id === current ? " (active)" : ""}`,
      );
      await ctx.sendActivity("**Available models:**\n\n" + lines.join("\n"));
      return true;
    }

    case "/thinking": {
      if (!arg) {
        const current = getThinkingTokens(conversationId);
        await ctx.sendActivity(
          current !== undefined && current !== null
            ? `Thinking budget: \`${current}\` tokens`
            : "No thinking budget override set.\n\nUsage: `/thinking <tokens>` or `/thinking off`",
        );
        return true;
      }

      if (arg.toLowerCase() === "off") {
        setThinkingTokens(conversationId, null);
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

      setThinkingTokens(conversationId, tokens);
      await ctx.sendActivity(`Thinking budget set to \`${tokens}\` tokens`);
      return true;
    }

    case "/permission": {
      if (!arg) {
        const current = getPermissionMode(conversationId);
        await ctx.sendActivity(
          current
            ? `Permission mode: \`${current}\``
            : "No permission mode override set (using `bypassPermissions`).\n\nUsage: `/permission <mode>`\nModes: `default`, `acceptEdits`, `bypassPermissions`",
        );
        return true;
      }

      if (!VALID_PERMISSION_MODES.includes(arg)) {
        await ctx.sendActivity(
          `Invalid mode: \`${arg}\`\n\nValid modes: ${VALID_PERMISSION_MODES.map((m) => `\`${m}\``).join(", ")}`,
        );
        return true;
      }

      setPermissionMode(conversationId, arg);
      await ctx.sendActivity(`Permission mode set to \`${arg}\``);
      return true;
    }

    case "/status": {
      const sessionId = getSession(conversationId);
      const workDir = getWorkDir(conversationId);
      const model = getModel(conversationId);
      const thinking = getThinkingTokens(conversationId);
      const permission = getPermissionMode(conversationId);

      const lines = [
        `**Session:** ${sessionId ? `\`${sessionId.slice(0, 12)}…\`` : "none"}`,
        `**Work dir:** \`${workDir}\``,
        `**Model:** ${model ? `\`${model}\`` : "default"}`,
        `**Thinking:** ${thinking !== undefined && thinking !== null ? `\`${thinking}\` tokens` : "default"}`,
        `**Permission:** \`${permission ?? "bypassPermissions"}\``,
      ];
      await ctx.sendActivity(lines.join("\n\n"));
      return true;
    }

    case "/help": {
      const card = buildHelpCard();
      await ctx.sendActivity({
        attachments: [CardFactory.adaptiveCard(card)],
      });
      return true;
    }

    default: {
      await ctx.sendActivity(`Unknown: \`${cmd}\`. Try \`/help\``);
      return true;
    }
  }
}
