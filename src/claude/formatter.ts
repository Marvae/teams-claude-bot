import type { ClaudeResult, ProgressEvent } from "./agent.js";

const MAX_MESSAGE_LENGTH = 25_000;

// ─── Code-block language mapping ─────────────────────────────────────────

export const EXT_LANG_OVERRIDE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  mjs: "javascript",
  py: "python",
  sh: "bash",
  zsh: "bash",
  cs: "csharp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  htm: "html",
  ps1: "powershell",
  kt: "kotlin",
  tex: "latex",
  yml: "yaml",
  m: "objective-c",
  mm: "objective-c",
  vb: "vb.net",
  vbs: "vbscript",
  v: "verilog",
  vhd: "vhdl",
  md: "markdown",
};

export function codeBlockLanguage(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return "plaintext";
  const ext = filePath.slice(dot + 1).toLowerCase();
  return EXT_LANG_OVERRIDE[ext] ?? ext;
}

export function truncateProgress(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

export function formatProgressMessage(
  event: ProgressEvent,
): string | undefined {
  if (event.type === "tool_summary") {
    return `📋 ${truncateProgress(event.summary, 200)}`;
  }
  if (event.type === "task_status") {
    const icon =
      event.status === "started"
        ? "🚀"
        : event.status === "completed"
          ? "✅"
          : event.status === "in_progress"
            ? "🔧"
            : "⚠️";
    return `${icon} Task: ${truncateProgress(event.summary, 150)}`;
  }
  if (event.type !== "tool_use") return undefined;
  const tool = event.tool;
  if (tool.name === "Bash") {
    return `🔧 Running: ${truncateProgress(tool.command ?? "bash", 100)}`;
  }
  if (tool.name === "Grep") {
    return `🔎 Searching: ${truncateProgress(tool.pattern ?? "pattern", 100)}`;
  }
  if (tool.name === "Read") {
    return tool.file
      ? `📖 Reading: ${truncateProgress(tool.file, 100)}`
      : "📖 Reading file...";
  }
  if (tool.name === "Edit") {
    return tool.file
      ? `✍️ Editing: ${truncateProgress(tool.file, 100)}`
      : "✍️ Editing file...";
  }
  if (tool.name === "Write") {
    return tool.file
      ? `✍️ Writing: ${truncateProgress(tool.file, 100)}`
      : "✍️ Writing file...";
  }
  return `🔧 Running: ${tool.name}`;
}

/** Convert a progress event to displayable text. Shared by streaming and proactive paths. */
export function progressToText(event: ProgressEvent, cwd?: string): string | undefined {
  if (event.type === "text" && event.text) return event.text;
  if (event.type === "file_diff") {
    const shortPath = cwd && event.filePath?.startsWith(cwd + "/")
      ? event.filePath.slice(cwd.length + 1)
      : event.filePath;
    const label = shortPath ?? "file";
    if (event.patch) {
      const lang = event.filePath ? codeBlockLanguage(event.filePath) : "plaintext";
      return `\n\n📝 ${label}\n\`\`\`${lang}\n${event.patch}\n\`\`\`\n\n`;
    }
    return `\n\n📝 Edited ${label}\n\n`;
  }
  if (event.type === "tool_result" && event.result) return `\n\n${event.result}\n\n`;
  if (event.type === "auth_error") return "\n\n🔑 Login expired — run `claude login` in terminal\n\n";
  if (event.type === "todo") {
    const completed = event.todos.filter((t) => t.status === "completed").length;
    const lines = event.todos.map((t) => {
      const icon = t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔧" : "⏳";
      const text = t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
      return `${icon} ${text}`;
    });
    return `\n\n📋 ${completed}/${event.todos.length}\n\n${lines.join("\n\n")}\n\n`;
  }
  if (event.type === "rate_limit") {
    const reset = event.resetsAt ? ` Resets at ${new Date(event.resetsAt).toLocaleTimeString()}.` : "";
    return event.status === "rejected"
      ? `\n\n⚠️ Rate limited.${reset}\n\n`
      : `\n\n⚠️ Approaching rate limit.${reset}\n\n`;
  }
  const msg = formatProgressMessage(event);
  return msg ? "\n\n" + msg + "\n\n" : undefined;
}

export function formatResponse(result: ClaudeResult): string {
  return result.result || "Done (no output)";
}

export function splitMessage(
  text: string,
  maxLen = MAX_MESSAGE_LENGTH,
): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt === -1) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
