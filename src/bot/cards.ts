// cards.ts — Adaptive Card builders using @microsoft/teams.cards typed API
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import type {
  ActivityParams,
  AdaptiveCardActionMessageResponse,
  AdaptiveCardActionErrorResponse,
} from "@microsoft/teams.api";
import type {
  IAdaptiveCard,
  CardElement,
  CardAction,
  CardElementArray,
} from "@microsoft/teams.cards";
import {
  AdaptiveCard,
  TextBlock,
  ColumnSet,
  Column,
  ActionSet,
  ExecuteAction,
  ShowCardAction,
  ChoiceSetInput,
  Choice,
  IMBackAction,
} from "@microsoft/teams.cards";
import {
  type AskUserQuestionInput,
  buildAskUserQuestionCardData,
  isAskUserQuestionInput,
} from "../claude/user-questions.js";
import * as state from "../session/state.js";
import {
  resolvePermission,
  resolvePermissionWithSuggestion,
} from "../claude/tool-interceptor.js";
import { resolveAskUserQuestion } from "../claude/user-questions.js";
import {
  resolveElicitation,
  resolveElicitationUrlComplete,
  cancelElicitation,
} from "../claude/elicitation.js";
import { resolvePromptRequest } from "../claude/user-input.js";

const CARD_VERSION = "1.5" as const;

/** Create an AdaptiveCard with the centralized version. */
export function adaptiveCard(...body: CardElementArray): AdaptiveCard {
  return new AdaptiveCard(...body).withOptions({ version: CARD_VERSION });
}

interface CommandDef {
  title: string;
  command: string;
  description: string;
}

interface CommandGroup {
  label: string;
  commands: CommandDef[];
}

const COMMAND_GROUPS: CommandGroup[] = [
  {
    label: "Session",
    commands: [
      { title: "/new", command: "/new", description: "Start a fresh session" },
      {
        title: "/stop",
        command: "/stop",
        description: "Interrupt current task",
      },
      {
        title: "/status",
        command: "/status",
        description: "Show session info",
      },
      {
        title: "/sessions",
        command: "/sessions",
        description: "List recent sessions",
      },
      {
        title: "/handoff",
        command: "/handoff",
        description: "Hand off from Terminal",
      },
    ],
  },
  {
    label: "Project",
    commands: [
      {
        title: "/project",
        command: "/project",
        description: "Show/change working directory",
      },
    ],
  },
  {
    label: "Configuration",
    commands: [
      { title: "/model", command: "/model", description: "Show/set model" },
      {
        title: "/models",
        command: "/models",
        description: "List available models",
      },
      {
        title: "/thinking",
        command: "/thinking",
        description: "Set thinking budget",
      },
      {
        title: "/permission",
        command: "/permission",
        description: "Set permission mode",
      },
    ],
  },
];

/** Build an AdaptiveCard from a body array and optional actions. */
function card(body: CardElement[], actions?: CardAction[]): IAdaptiveCard {
  const c = adaptiveCard(...body);
  if (actions) c.actions = actions;
  return c;
}

export function buildHelpCard(
  sdkCommands?: Array<{ name: string; description: string }>,
): IAdaptiveCard {
  const body: CardElement[] = [
    new TextBlock("Claude Code Teams Bot", {
      weight: "Bolder",
      size: "Large",
    }),
    new TextBlock(
      "Send any message to Claude Code. Use different chats for different projects.",
      { wrap: true, spacing: "Small" },
    ),
  ];

  for (const group of COMMAND_GROUPS) {
    body.push(
      new TextBlock(group.label, {
        weight: "Bolder",
        size: "Medium",
        spacing: "Large",
      }),
    );

    const columns = group.commands.map((cmd) =>
      new Column(
        new ActionSet(new IMBackAction(cmd.command, { title: cmd.title })),
      ).withOptions({ width: "auto" }),
    );

    body.push(new ColumnSet({ columns }));
  }

  // SDK slash commands — all displayed inline, 3 per row
  if (sdkCommands && sdkCommands.length > 0) {
    const COLS_PER_ROW = 3;

    body.push(
      new TextBlock("Claude Code", {
        weight: "Bolder",
        size: "Medium",
        spacing: "Large",
      }),
    );

    for (let i = 0; i < sdkCommands.length; i += COLS_PER_ROW) {
      const columns = sdkCommands
        .slice(i, i + COLS_PER_ROW)
        .map((cmd) =>
          new Column(
            new ActionSet(
              new IMBackAction(`/${cmd.name}`, { title: `/${cmd.name}` }),
            ),
          ).withOptions({ width: "stretch" }),
        );
      body.push(new ColumnSet({ columns }));
    }
  }

  return card(body);
}

function suggestionLabel(s: PermissionUpdate): string {
  const destLabel: Record<string, string> = {
    session: "for session",
    projectSettings: "for project",
    localSettings: "locally",
    userSettings: "globally",
  };
  const scope = destLabel[s.destination] ?? s.destination;
  if ("rules" in s && s.rules.length > 0) {
    const action = s.rules[0].toolName ?? "tool";
    const content = s.rules[0].ruleContent;
    if (content) {
      return `Allow ${action} in ${content} ${scope}`;
    }
    return `Allow ${action} ${scope}`;
  }
  if (s.type === "setMode" && "mode" in s) {
    return `Set ${s.mode} ${scope}`;
  }
  return `Allow ${scope}`;
}

export function buildToolCard(
  toolName: string,
  input: Record<string, unknown>,
  toolUseID: string,
  decisionReason?: string,
  suggestions?: PermissionUpdate[],
  result?: string,
): IAdaptiveCard {
  if (toolName === "AskUserQuestion" && isAskUserQuestionInput(input)) {
    return buildAskUserQuestionCard(input, toolUseID);
  }

  const inputDisplay = JSON.stringify(input, null, 2).slice(0, 500);

  const oneLiner = JSON.stringify(input);
  const summary =
    oneLiner.length > 120 ? oneLiner.slice(0, 117) + "..." : oneLiner;

  const body: CardElement[] = [
    new TextBlock(`🔒 **${toolName}**`, { wrap: true, size: "Small" }),
    new TextBlock(summary, {
      wrap: true,
      fontType: "Monospace",
      size: "Small",
      spacing: "Small",
    }),
  ];

  if (decisionReason) {
    body.push(
      new TextBlock(decisionReason, {
        wrap: true,
        isSubtle: true,
        size: "Small",
        spacing: "Small",
      }),
    );
  }

  if (result) {
    body.push(new TextBlock(result, { weight: "Bolder", spacing: "Medium" }));
    return card(body);
  }

  // Single ChoiceSet + Submit (avoids accidental double-click on separate buttons)
  const choices = [new Choice({ title: "✅ Allow", value: "allow" })];

  if (suggestions) {
    for (let i = 0; i < suggestions.length; i++) {
      choices.push(
        new Choice({
          title: `✅ ${suggestionLabel(suggestions[i])}`,
          value: `suggestion_${i}`,
        }),
      );
    }
  }

  choices.push(new Choice({ title: "❌ Deny", value: "deny" }));

  body.push(
    new ChoiceSetInput(...choices).withOptions({
      id: "permissionChoice",
      style: "expanded",
      value: "allow",
    }),
  );

  const actions: CardAction[] = [
    new ExecuteAction({
      title: "Submit",
      style: "positive",
      data: { action: "permission_decision", toolUseID },
    }),
  ];

  // Only show Details if the summary was truncated
  if (oneLiner.length > 120) {
    actions.push(
      new ShowCardAction({
        title: "Details",
        card: adaptiveCard(
          new TextBlock(`\`\`\`\n${inputDisplay}\n\`\`\``, {
            wrap: true,
            fontType: "Monospace",
            size: "Small",
          }),
        ),
      }),
    );
  }

  return card(body, actions);
}

export function buildAskUserQuestionCard(
  input: AskUserQuestionInput,
  toolUseID: string,
): IAdaptiveCard {
  return buildAskUserQuestionCardData(input, toolUseID);
}

export function buildHandoffCard(
  workDir: string,
  sessionId?: string,
  summary?: string,
  todos?: { content: string; done: boolean }[],
  buttonText?: string,
  title?: string,
  result?: string,
): IAdaptiveCard {
  const dirName = workDir?.split("/").pop() ?? workDir ?? "unknown";

  const body: CardElement[] = [
    new ColumnSet({
      columns: [
        new Column(
          new TextBlock(title || "Session Summary", {
            size: "Medium",
            weight: "Bolder",
          }),
          new TextBlock(`📂 ${dirName}`, {
            size: "Small",
            isSubtle: true,
            spacing: "None",
          }),
        ).withOptions({ width: "stretch" }),
      ],
    }),
  ];

  if (summary) {
    body.push(new TextBlock(summary, { wrap: true, spacing: "Medium" }));
  }

  if (todos && todos.length > 0) {
    for (let i = 0; i < todos.length; i++) {
      const t = todos[i];
      body.push(
        new TextBlock(`${t.done ? "✅" : "⬜"} ${t.content}`, {
          wrap: true,
          spacing: i === 0 ? "Medium" : "None",
          isSubtle: t.done,
        }),
      );
    }
  }

  if (result) {
    body.push(
      new TextBlock(result, {
        weight: "Bolder",
        color: "Good",
        spacing: "Medium",
      }),
    );
    return card(body);
  }

  return card(body, [
    new ExecuteAction({
      title: buttonText || "Accept Handoff",
      style: "positive",
      data: {
        action: "handoff_accept",
        workDir,
        sessionId,
        summary,
        todos,
        title,
      },
    }),
  ]);
}

export function buildPermissionModeCard(currentMode: string): IAdaptiveCard {
  const modes = [
    { id: "default", label: "🛡️ Default", desc: "Ask before risky actions" },
    { id: "auto", label: "🤖 Auto mode", desc: "AI decides, blocks unsafe actions" },
    { id: "acceptEdits", label: "📝 Accept edits", desc: "Auto-approve file edits" },
    { id: "plan", label: "📋 Plan mode", desc: "Read-only, no execution" },
    { id: "dontAsk", label: "🔒 Don't Ask", desc: "Only pre-approved tools" },
    { id: "bypassPermissions", label: "⚡ Bypass Permissions", desc: "Skip all checks" },
  ];

  const current = modes.find((m) => m.id === currentMode);
  const currentLabel = current ? current.label : currentMode;

  const actions = modes
    .filter((m) => m.id !== currentMode)
    .map(
      (m) =>
        new ExecuteAction({
          title: `${m.label}  ·  ${m.desc}`,
          data: { action: "set_permission_mode", mode: m.id },
        }),
    );

  return card(
    [
      new TextBlock(`Current: **${currentLabel}**`, {
        size: "Medium",
        weight: "Bolder",
      }),
    ],
    actions,
  );
}

// ─── Card Action Handler ─────────────────────────────────────────────────
//
// Handles all Action.Execute invocations from Adaptive Cards.

// Shared interactive card tracking (tool approval cards, elicitation cards, etc.)
export const interactiveCards = new Map<
  string,
  {
    toolName: string;
    input: Record<string, unknown>;
    decisionReason?: string;
    suggestions?: PermissionUpdate[];
    activityId: string;
  }
>();

type CardActionResponse =
  | AdaptiveCardActionMessageResponse
  | AdaptiveCardActionErrorResponse;

/** Delete an interactive card by its tracking ID (permission, elicitation, etc.) */
async function deleteInteractiveCard(
  id: string,
  deleteFn?: (activityId: string) => Promise<void>,
): Promise<void> {
  const cardInfo = interactiveCards.get(id);
  interactiveCards.delete(id);
  if (cardInfo && deleteFn) {
    try {
      await deleteFn(cardInfo.activityId);
    } catch {
      /* card may be gone */
    }
  }
}

function actionMsg(value: string): AdaptiveCardActionMessageResponse {
  return {
    statusCode: 200,
    type: "application/vnd.microsoft.activity.message",
    value,
  };
}

/**
 * Handle all card.action (Action.Execute) invocations.
 */
export async function handleCardAction(
  data: Record<string, unknown>,
  sendFn: (activity: string | ActivityParams) => Promise<void>,
  deleteFn?: (activityId: string) => Promise<void>,
  replyToId?: string,
): Promise<CardActionResponse> {
  const action = data.action as string | undefined;
  if (!action) return actionMsg("No action specified");

  const deleteCard = async () => {
    if (replyToId && deleteFn) {
      try {
        await deleteFn(replyToId);
      } catch {
        /* card may be gone */
      }
    }
  };

  switch (action) {
    case "resume_session": {
      const sessionId = data.sessionId as string;
      if (!sessionId) {
        await sendFn("Session not found.");
        break;
      }
      const currentId = state.getSession()?.session.currentSessionId;
      if (sessionId === currentId) {
        await deleteCard();
        await sendFn("That session is already active.");
        break;
      }
      const sessionCwds = data.sessionCwds as
        | Record<string, string | undefined>
        | undefined;
      const cwd = sessionCwds?.[sessionId] ?? (data.cwd as string | undefined);
      if (cwd) {
        const r = state.setWorkDir(cwd);
        if (!r.ok) {
          await sendFn(
            `Cannot resume — \`${cwd}\` is outside the allowed work directory.`,
          );
          break;
        }
      }
      await deleteCard();
      state.destroySession();
      state.persistSessionId(sessionId);
      const dirLabel = cwd ? `\n\n📂 ${cwd}` : "";
      await sendFn(
        `🔄 Resumed session \`${sessionId.slice(0, 8)}…\`${dirLabel}`,
      );
      break;
    }

    case "handoff_fork":
      await deleteCard();
      break; // No-op here — index.ts card.action handler sends the fork card (needs app context)

    case "handoff_accept":
      break; // No-op here — index.ts card.action handler updates card + runs handleHandoff

    case "permission_decision": {
      const toolUseID = data.toolUseID as string;
      const choice = (data.permissionChoice as string) ?? "deny";
      if (choice.startsWith("suggestion_")) {
        resolvePermissionWithSuggestion(
          toolUseID,
          parseInt(choice.replace("suggestion_", ""), 10),
        );
      } else {
        resolvePermission(toolUseID, choice === "allow");
      }
      await deleteInteractiveCard(toolUseID, deleteFn);
      break;
    }

    case "permission_allow":
    case "permission_deny":
    case "permission_allow_session": {
      const toolUseID = data.toolUseID as string;
      if (action === "permission_allow_session") {
        resolvePermissionWithSuggestion(
          toolUseID,
          data.suggestionIndex as number,
        );
      } else {
        resolvePermission(toolUseID, action !== "permission_deny");
      }
      await deleteInteractiveCard(toolUseID, deleteFn);
      break;
    }

    case "ask_user_question_submit": {
      const toolUseID = data.toolUseID as string;
      const resolved = resolveAskUserQuestion(toolUseID, data);
      await deleteInteractiveCard(toolUseID, deleteFn);
      if (!resolved) await sendFn("Question request expired or not found.");
      break;
    }

    case "elicitation_form_submit": {
      const id = data.elicitationId as string;
      const resolved = resolveElicitation(id, data);
      await deleteInteractiveCard(id, deleteFn);
      await sendFn(
        resolved ? "✅ Submitted" : "Elicitation request expired or not found.",
      );
      break;
    }

    case "elicitation_url_complete": {
      const id = data.elicitationId as string;
      const resolved = resolveElicitationUrlComplete(id);
      await deleteInteractiveCard(id, deleteFn);
      await sendFn(
        resolved
          ? "✅ Authorization confirmed"
          : "Elicitation request expired or not found.",
      );
      break;
    }

    case "elicitation_form_cancel": {
      const id = data.elicitationId as string;
      const resolved = cancelElicitation(id);
      await deleteInteractiveCard(id, deleteFn);
      await sendFn(
        resolved ? "❌ Canceled" : "Elicitation request expired or not found.",
      );
      break;
    }

    case "set_permission_mode": {
      const mode = data.mode as string;
      try {
        await state.getSession()?.session.setPermissionMode(mode);
        state.setPermissionMode(mode);
        await deleteCard();
        await sendFn(`Permission mode set to \`${mode}\``);
      } catch (err) {
        await sendFn(
          `Failed to set \`${mode}\`: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      break;
    }

    case "prompt_response": {
      const requestId = data.requestId as string;
      const key = data.key as string;
      const resolved = resolvePromptRequest(requestId, key);
      interactiveCards.delete(requestId);
      await deleteCard();
      await sendFn(
        resolved ? `Selected: ${key}` : "Prompt request expired or not found.",
      );
      break;
    }

    case "noop":
      await deleteCard();
      break;

    default:
      break;
  }

  return actionMsg("Action processed");
}
