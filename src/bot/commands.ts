import { CardFactory, type TurnContext } from "botbuilder";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import * as state from "../session/state.js";
import {
  buildHelpCard,
  buildPermissionModeCard,
  buildToolCard,
  buildHandoffCard,
  buildElicitationFormCard,
  buildElicitationUrlCard,
} from "./cards.js";
import { createPromptCard } from "../claude/user-input.js";
import {
  buildAskUserQuestionCardData,
  type AskUserQuestionInput,
} from "../claude/user-questions.js";

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

      const body: unknown[] = [
        {
          type: "TextBlock",
          text: "Sessions",
          weight: "bolder",
          size: "medium",
        },
        {
          type: "Input.ChoiceSet",
          id: "sessionId",
          style: "expanded",
          value: currentId ?? sdkSessions[0].sessionId,
          choices,
        },
      ];

      const card = CardFactory.adaptiveCard({
        type: "AdaptiveCard",
        version: "1.4",
        body,
        actions: [
          {
            type: "Action.Submit",
            title: "Submit",
            style: "positive",
            data: {
              action: "resume_session",
              sessionCwds,
            },
          },
          {
            type: "Action.Submit",
            title: "Cancel",
            data: { action: "noop" },
          },
        ],
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

    case "/test-permission": {
      const card = buildToolCard(
        "Bash",
        { command: "rm -rf /tmp/test-data" },
        `test-perm-${Date.now()}`,
        "potentially dangerous command",
      );
      await ctx.sendActivity({
        attachments: [CardFactory.adaptiveCard(card)],
      });
      return true;
    }

    case "/test-permission-suggestion": {
      const card = buildToolCard(
        "Bash",
        { command: "ls /home/user/projects" },
        `test-perm-sug-${Date.now()}`,
        "directory access",
        [
          {
            type: "addRules",
            destination: "session",
            rules: [{ toolName: "Bash", ruleContent: "/home/user/projects" }],
          } as import("@anthropic-ai/claude-agent-sdk").PermissionUpdate,
        ],
      );
      await ctx.sendActivity({
        attachments: [CardFactory.adaptiveCard(card)],
      });
      return true;
    }

    case "/test-elicitation": {
      const card = buildElicitationFormCard(`test-elic-${Date.now()}`, {
        serverName: "test-mcp-server",
        message: "Please provide your configuration",
        mode: "form",
        elicitationId: `test-elic-${Date.now()}`,
        requestedSchema: {
          type: "object",
          properties: {
            project: { type: "string", title: "Project Name" },
            branch: { type: "string", title: "Branch" },
          },
          required: ["project"],
        },
      });
      await ctx.sendActivity({
        attachments: [CardFactory.adaptiveCard(card)],
      });
      return true;
    }

    case "/test-elicitation-url": {
      const card = buildElicitationUrlCard(`test-elic-url-${Date.now()}`, {
        serverName: "github-mcp",
        message: "Please authorize access to your GitHub account",
        mode: "url",
        elicitationId: `test-elic-url-${Date.now()}`,
        url: "https://github.com/login/oauth/authorize?client_id=test",
      });
      await ctx.sendActivity({
        attachments: [CardFactory.adaptiveCard(card)],
      });
      return true;
    }

    case "/test-prompt": {
      const card = createPromptCard(
        `test-prompt-${Date.now()}`,
        "How would you like to proceed?",
        [
          { key: "retry", label: "Retry" },
          { key: "skip", label: "Skip" },
          { key: "abort", label: "Abort" },
        ],
      );
      await ctx.sendActivity({
        attachments: [CardFactory.adaptiveCard(card)],
      });
      return true;
    }

    case "/test-handoff": {
      const card = buildHandoffCard(
        "/Users/test/projects/my-app",
        "test-session-abc123",
        "Working on feature branch: add-auth\n\nLast action: Updated login component",
        [
          { content: "Add OAuth provider", done: true },
          { content: "Implement token refresh", done: false },
          { content: "Write tests", done: false },
        ],
      );
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

    case "/test-question": {
      const input: AskUserQuestionInput = {
        questions: [
          {
            question: "Which testing framework do you prefer?",
            header: "Testing Setup",
            options: [
              { label: "Vitest", description: "Fast, Vite-native" },
              { label: "Jest", description: "Widely adopted" },
              { label: "Mocha", description: "Flexible, minimal" },
            ],
            multiSelect: false,
            allowFreeText: true,
          },
        ],
      };
      const cardData = buildAskUserQuestionCardData(
        input,
        `test-question-${Date.now()}`,
      );
      await ctx.sendActivity({
        attachments: [
          CardFactory.adaptiveCard({
            type: "AdaptiveCard",
            version: "1.4",
            $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
            body: cardData.body,
            actions: cardData.actions,
          }),
        ],
      });
      return true;
    }

    case "/test-session": {
      const card = CardFactory.adaptiveCard({
        type: "AdaptiveCard",
        version: "1.4",
        body: [
          {
            type: "TextBlock",
            text: "Sessions (Test)",
            weight: "bolder",
            size: "medium",
          },
          {
            type: "Input.ChoiceSet",
            id: "sessionId",
            style: "expanded",
            value: "sess-abc",
            choices: [
              {
                title: "Feature Auth (my-app · 2h ago · main)",
                value: "sess-abc",
              },
              {
                title: "Bug Fix #123 (api · 5h ago · fix/123)",
                value: "sess-def",
              },
              { title: "Code Review (frontend · 1d ago)", value: "sess-ghi" },
            ],
          },
        ],
        actions: [
          {
            type: "Action.Submit",
            title: "Submit",
            style: "positive",
            data: { action: "resume_session", sessionCwds: {} },
          },
          { type: "Action.Submit", title: "Cancel", data: { action: "noop" } },
        ],
      });
      await ctx.sendActivity({ attachments: [card] });
      return true;
    }

    case "/test-permission-mode": {
      const card = buildPermissionModeCard(state.getPermissionMode());
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
