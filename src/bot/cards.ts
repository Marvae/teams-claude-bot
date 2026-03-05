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

  // SDK slash commands — show first row inline, rest in expandable card
  const actions: Record<string, unknown>[] = [];
  if (sdkCommands && sdkCommands.length > 0) {
    const COLS_PER_ROW = 4;
    const pinned = ["compact", "cost", "review", "init"];
    const pinnedCmds = sdkCommands.filter((c) => pinned.includes(c.name));
    const restCmds = sdkCommands.filter((c) => !pinned.includes(c.name));

    body.push({
      type: "TextBlock",
      text: "Claude Code",
      weight: "bolder",
      size: "medium",
      spacing: "large",
    });

    // Pinned row — always visible
    if (pinnedCmds.length > 0) {
      const row = pinnedCmds.map((cmd) => ({
        type: "Column",
        width: "auto",
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

    // Rest — expandable
    if (restCmds.length > 0) {
      const restBody: Record<string, unknown>[] = [];
      for (let i = 0; i < restCmds.length; i += COLS_PER_ROW) {
        const row = restCmds.slice(i, i + COLS_PER_ROW).map((cmd) => ({
          type: "Column",
          width: "auto",
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
        restBody.push({ type: "ColumnSet", columns: row });
      }

      actions.push({
        type: "Action.ShowCard",
        title: `More (${restCmds.length})`,
        card: { type: "AdaptiveCard", body: restBody },
      });
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

  const actions: Record<string, unknown>[] = [
    {
      type: "Action.Submit",
      title: "✅ Allow",
      style: "positive",
      data: { action: "permission_allow", toolUseID },
    },
  ];

  if (suggestions) {
    for (let i = 0; i < suggestions.length; i++) {
      actions.push({
        type: "Action.Submit",
        title: `✅ ${suggestionLabel(suggestions[i])}`,
        style: "positive",
        data: {
          action: "permission_allow_session",
          toolUseID,
          suggestionIndex: i,
        },
      });
    }
  }

  actions.push({
    type: "Action.Submit",
    title: "❌ Deny",
    style: "destructive",
    data: { action: "permission_deny", toolUseID },
  });

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
): Record<string, unknown> {
  const dirName = workDir.split("/").pop() ?? workDir;

  return {
    type: "AdaptiveCard",
    version: "1.4",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    body: [
      {
        type: "TextBlock",
        text: `🔄 Handoff — **${dirName}**`,
        size: "small",
      },
      {
        type: "TextBlock",
        text: "Accept to fork the terminal session here. Terminal keeps working independently.",
        wrap: true,
        size: "small",
        isSubtle: true,
        spacing: "small",
      },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Accept Handoff",
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
  currentMode?: string,
): Record<string, unknown> {
  const modes = [
    {
      id: "default",
      label: "🛡️ Default",
      desc: "Ask before risky operations",
    },
    {
      id: "acceptEdits",
      label: "📝 Accept Edits",
      desc: "Auto-allow file edits, ask for others",
    },
    {
      id: "plan",
      label: "Plan mode - Claude explains what it would do without executing",
      desc: "Preview actions without running tools",
    },
    {
      id: "dontAsk",
      label: "Don't ask - Auto-approve all tools (less strict than bypass)",
      desc: "Auto-approve tools without confirmation",
    },
    {
      id: "bypassPermissions",
      label: "⚡ Bypass",
      desc: "Allow everything (fast but risky)",
    },
  ];

  const body: Record<string, unknown>[] = [
    {
      type: "TextBlock",
      text: currentMode
        ? `Permission: **${currentMode}**`
        : "Permission: **bypassPermissions**",
      size: "small",
    },
  ];

  const actions = modes.map((m) => ({
    type: "Action.Submit",
    title: m.label,
    data: {
      action: "set_permission_mode",
      mode: m.id,
    },
  }));

  return {
    type: "AdaptiveCard",
    version: "1.4",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    body,
    actions,
  };
}
