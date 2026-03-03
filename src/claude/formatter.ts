import type { ClaudeResult, ToolInfo } from "./agent.js";

const MAX_MESSAGE_LENGTH = 25_000;

function formatTool(t: ToolInfo): string {
  if (t.file) return `- **${t.name}**: \`${t.file}\``;
  if (t.command) return `- **${t.name}**: \`${t.command}\``;
  if (t.pattern) return `- **${t.name}**: \`${t.pattern}\``;
  return `- **${t.name}**`;
}

export function formatResponse(result: ClaudeResult): string {
  const parts: string[] = [];

  if (result.tools.length > 0) {
    parts.push(result.tools.map(formatTool).join("\n"));
    parts.push("---");
  }

  if (result.result) {
    parts.push(result.result);
  }

  return parts.length > 0 ? parts.join("\n\n") : "Done (no output)";
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
