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
      { title: "/clear", command: "/clear", description: "Alias for /new" },
      { title: "/compact", command: "/compact", description: "Clear with fresh context" },
      { title: "/status", command: "/status", description: "Show session info" },
    ],
  },
  {
    label: "Project",
    commands: [
      { title: "/project", command: "/project", description: "Show/change working directory" },
    ],
  },
  {
    label: "Configuration",
    commands: [
      { title: "/model", command: "/model", description: "Show/set model" },
      { title: "/models", command: "/models", description: "List available models" },
      { title: "/thinking", command: "/thinking", description: "Set thinking budget" },
      { title: "/permission", command: "/permission", description: "Set permission mode" },
    ],
  },
];

export function buildHelpCard(): Record<string, unknown> {
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

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body,
  };
}
