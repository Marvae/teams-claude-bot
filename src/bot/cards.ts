// cards.ts
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import {
  type AskUserQuestionInput,
  buildAskUserQuestionCardData,
  isAskUserQuestionInput,
} from "../claude/user-questions.js";
import {
  buildElicitationCard,
  buildElicitationUrlCard as buildClaudeElicitationUrlCard,
  type ElicitationRequest,
} from "../claude/elicitation.js";

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

export function buildHelpCard(
  sdkCommands?: Array<{ name: string; description: string }>,
): Record<string, unknown> {
  const body: Record<string, unknown>[] = [
    {
      type: "TextBlock",
      text: "Claude Code Teams Bot",
      weight: "bolder",
      size: "large",
    },
    {
      type: "TextBlock",
      text: "Send any message to Claude Code. Use different chats for different projects.",
      wrap: true,
      spacing: "small",
    },
  ];

  for (const group of COMMAND_GROUPS) {
    body.push({
      type: "TextBlock",
      text: group.label,
      weight: "bolder",
      size: "medium",
      spacing: "large",
    });

    const columns: Record<string, unknown>[] = [];
    for (const cmd of group.commands) {
      columns.push({
        type: "Column",
        width: "auto",
        items: [
          {
            type: "ActionSet",
            actions: [
              {
                type: "Action.Submit",
                title: cmd.title,
                data: { msteams: { type: "imBack", value: cmd.command } },
              },
            ],
          },
        ],
      });
    }

    body.push({ type: "ColumnSet", columns });
  }

  // SDK slash commands — all displayed inline, 3 per row
  const actions: Record<string, unknown>[] = [];
  if (sdkCommands && sdkCommands.length > 0) {
    const COLS_PER_ROW = 3;

    body.push({
      type: "TextBlock",
      text: "Claude Code",
      weight: "bolder",
      size: "medium",
      spacing: "large",
    });

    for (let i = 0; i < sdkCommands.length; i += COLS_PER_ROW) {
      const row = sdkCommands.slice(i, i + COLS_PER_ROW).map((cmd) => ({
        type: "Column",
        width: "stretch",
        items: [
          {
            type: "ActionSet",
            actions: [
              {
                type: "Action.Submit",
                title: `/${cmd.name}`,
                data: {
                  msteams: { type: "imBack", value: `/${cmd.name}` },
                },
              },
            ],
          },
        ],
      }));
      body.push({ type: "ColumnSet", columns: row });
    }
  }

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body,
    ...(actions.length > 0 ? { actions } : {}),
  };
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
): Record<string, unknown> {
  if (toolName === "AskUserQuestion" && isAskUserQuestionInput(input)) {
    return buildAskUserQuestionCard(input, toolUseID);
  }

  const inputDisplay = JSON.stringify(input, null, 2).slice(0, 500);

  const oneLiner = JSON.stringify(input);
  const summary =
    oneLiner.length > 120 ? oneLiner.slice(0, 117) + "..." : oneLiner;

  const body: Record<string, unknown>[] = [
    {
      type: "TextBlock",
      text: `🔒 **${toolName}**`,
      wrap: true,
      size: "small",
    },
    {
      type: "TextBlock",
      text: summary,
      wrap: true,
      fontType: "monospace",
      size: "small",
      spacing: "small",
    },
  ];

  if (decisionReason) {
    body.push({
      type: "TextBlock",
      text: decisionReason,
      wrap: true,
      isSubtle: true,
      size: "small",
      spacing: "small",
    });
  }

  if (result) {
    body.push({
      type: "TextBlock",
      text: result,
      weight: "bolder",
      spacing: "medium",
    });
    return {
      type: "AdaptiveCard",
      version: "1.4",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      body,
    };
  }

  // Single ChoiceSet + Submit (avoids accidental double-click on separate buttons)
  const choices: { title: string; value: string }[] = [
    { title: "✅ Allow", value: "allow" },
  ];

  if (suggestions) {
    for (let i = 0; i < suggestions.length; i++) {
      choices.push({
        title: `✅ ${suggestionLabel(suggestions[i])}`,
        value: `suggestion_${i}`,
      });
    }
  }

  choices.push({ title: "❌ Deny", value: "deny" });

  body.push({
    type: "Input.ChoiceSet",
    id: "permissionChoice",
    style: "expanded",
    value: "allow",
    choices,
  });

  const actions: Record<string, unknown>[] = [
    {
      type: "Action.Submit",
      title: "Submit",
      style: "positive",
      data: { action: "permission_decision", toolUseID },
    },
  ];

  // Only show Details if the summary was truncated
  if (oneLiner.length > 120) {
    actions.push({
      type: "Action.ShowCard",
      title: "Details",
      card: {
        type: "AdaptiveCard",
        body: [
          {
            type: "TextBlock",
            text: `\`\`\`\n${inputDisplay}\n\`\`\``,
            wrap: true,
            fontType: "monospace",
            size: "small",
          },
        ],
      },
    });
  }

  return {
    type: "AdaptiveCard",
    version: "1.4",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    body,
    actions,
  };
}

export function buildAskUserQuestionCard(
  input: AskUserQuestionInput,
  toolUseID: string,
): Record<string, unknown> {
  const questionCard = buildAskUserQuestionCardData(input, toolUseID);

  return {
    type: "AdaptiveCard",
    version: "1.4",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    body: questionCard.body,
    actions: questionCard.actions,
  };
}

export function buildElicitationFormCard(
  elicitationId: string,
  request: ElicitationRequest,
): Record<string, unknown> {
  const card = buildElicitationCard(elicitationId, request);

  return {
    type: "AdaptiveCard",
    version: "1.4",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    body: card.body,
    actions: card.actions,
  };
}

export function buildElicitationUrlCard(
  elicitationId: string,
  request: ElicitationRequest,
): Record<string, unknown> {
  const card = buildClaudeElicitationUrlCard(elicitationId, request);

  return {
    type: "AdaptiveCard",
    version: "1.4",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    body: card.body,
    actions: card.actions,
  };
}

export function buildHandoffCard(
  workDir: string,
  sessionId?: string,
  summary?: string,
  todos?: { content: string; done: boolean }[],
  buttonText?: string,
  title?: string,
  result?: string,
): Record<string, unknown> {
  const dirName = workDir?.split("/").pop() ?? workDir ?? "unknown";

  const body: Record<string, unknown>[] = [
    {
      type: "ColumnSet",
      columns: [
        {
          type: "Column",
          width: "stretch",
          items: [
            {
              type: "TextBlock",
              text: title || "Session Summary",
              size: "medium",
              weight: "bolder",
            },
            {
              type: "TextBlock",
              text: `📂 ${dirName}`,
              size: "small",
              isSubtle: true,
              spacing: "none",
            },
          ],
        },
      ],
    },
  ];

  if (summary) {
    body.push({
      type: "TextBlock",
      text: summary,
      wrap: true,
      spacing: "medium",
    });
  }

  if (todos && todos.length > 0) {
    for (let i = 0; i < todos.length; i++) {
      const t = todos[i];
      body.push({
        type: "TextBlock",
        text: `${t.done ? "✅" : "⬜"} ${t.content}`,
        wrap: true,
        spacing: i === 0 ? "medium" : "none",
        isSubtle: t.done,
      });
    }
  }

  if (result) {
    body.push({
      type: "TextBlock",
      text: result,
      weight: "bolder",
      color: "good",
      spacing: "medium",
    });
    return {
      type: "AdaptiveCard",
      version: "1.4",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      body,
    };
  }

  return {
    type: "AdaptiveCard",
    version: "1.4",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    body,
    actions: [
      {
        type: "Action.Submit",
        title: buttonText || "Accept Handoff",
        style: "positive",
        data: {
          action: "handoff_accept",
          workDir,
          sessionId,
        },
      },
    ],
  };
}

export function buildPermissionModeCard(
  currentMode: string,
): Record<string, unknown> {
  const modes = [
    { id: "default", label: "🛡️ Default", desc: "Ask before risky operations" },
    {
      id: "auto",
      label: "🤖 Auto",
      desc: "AI decides safe actions, asks for risky ones",
    },
    {
      id: "acceptEdits",
      label: "📝 Accept Edits",
      desc: "Auto-allow file edits, ask for others",
    },
    { id: "plan", label: "📋 Plan", desc: "Preview actions without executing" },
    { id: "dontAsk", label: "✅ Don't Ask", desc: "Auto-approve all tools" },
    {
      id: "bypassPermissions",
      label: "⚡ Bypass",
      desc: "Skip all permission checks",
    },
  ];

  const current = modes.find((m) => m.id === currentMode);
  const currentLabel = current ? current.label : currentMode;

  const actions = modes
    .filter((m) => m.id !== currentMode)
    .map((m) => ({
      type: "Action.Submit",
      title: `${m.label}  ·  ${m.desc}`,
      data: { action: "set_permission_mode", mode: m.id },
    }));

  return {
    type: "AdaptiveCard",
    version: "1.4",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    body: [
      {
        type: "TextBlock",
        text: `Current: **${currentLabel}**`,
        size: "medium",
        weight: "bolder",
      },
    ],
    actions,
  };
}
