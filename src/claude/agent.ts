import {
  getSessionMessages,
  type CanUseTool as SDKCanUseTool,
  type PromptRequestOption,
} from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "os";

export interface ToolInfo {
  name: string;
  file?: string;
  command?: string;
  pattern?: string;
}

export interface ClaudeResult {
  error?: string;
  sessionId?: string;
  result?: string;
  tools: ToolInfo[];
  stopReason?: string | null;
  interrupted?: boolean;
}

export interface ImageInput {
  mediaType: string;
  data: string;
}

export type ProgressEvent =
  | { type: "tool_use"; tool: ToolInfo }
  | { type: "tool_summary"; summary: string }
  | { type: "task_status"; taskId: string; status: string; summary: string }
  | { type: "text"; text: string }
  | { type: "done" };

export interface PromptRequestInfo {
  requestId: string;
  message: string;
  options: PromptRequestOption[];
}

export interface ElicitationRequest {
  serverName: string;
  message: string;
  mode?: "form" | "url";
  url?: string;
  elicitationId?: string;
  requestedSchema?: Record<string, unknown>;
}

export interface ElicitationResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

export type OnElicitation = (
  request: ElicitationRequest,
) => Promise<ElicitationResult>;

export type CanUseTool = SDKCanUseTool;

/** Extract ToolInfo from a tool name + input object. */
export function extractToolInfo(
  toolName: string,
  input?: Record<string, unknown>,
): ToolInfo {
  const info: ToolInfo = { name: toolName };
  if (input) {
    if (typeof input.file_path === "string") info.file = input.file_path;
    if (typeof input.command === "string")
      info.command = input.command.slice(0, 100);
    if (typeof input.pattern === "string") info.pattern = input.pattern;
  }
  return info;
}

const EXT_MAP: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

export async function saveImagesToTmp(images: ImageInput[]): Promise<string[]> {
  const { writeFile, mkdir } = await import("fs/promises");
  const { join } = await import("path");
  const { randomUUID } = await import("crypto");
  const dir = join(tmpdir(), "teams-claude-bot");
  await mkdir(dir, { recursive: true });

  const paths: string[] = [];
  for (const img of images) {
    const ext = EXT_MAP[img.mediaType] ?? ".png";
    const p = join(dir, `${randomUUID()}${ext}`);
    await writeFile(p, Buffer.from(img.data, "base64"));
    paths.push(p);
  }
  return paths;
}

/**
 * Build a readable context string from recent messages in a session,
 * using the SDK's getSessionMessages API.
 * Skips tool_use / tool_result blocks to keep the summary clean.
 */
export async function buildSessionContext(
  sessionId: string,
  limit = 15,
): Promise<string> {
  try {
    const messages = await getSessionMessages(sessionId, { limit });
    const lines: string[] = [];

    for (const m of messages) {
      const role = m.type === "user" ? "User" : "Assistant";
      const msg = m.message as Record<string, unknown> | undefined;
      if (!msg) continue;

      const content = msg.content;
      let text = "";

      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content as Record<string, unknown>[]) {
          // Only extract plain text blocks, skip tool_use / tool_result
          if (block.type === "text" && typeof block.text === "string") {
            parts.push(block.text);
          }
        }
        text = parts.join(" ");
      }

      const trimmed = text.trim();
      if (trimmed) {
        lines.push(`${role}: ${trimmed.slice(0, 400)}`);
      }
    }

    return lines.join("\n");
  } catch {
    return "";
  }
}
