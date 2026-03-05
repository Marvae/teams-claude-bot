import {
  type CanUseTool as SDKCanUseTool,
  type PromptRequestOption,
} from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "os";
import type { ErrorCode } from "../errors/error-codes.js";
import { logError, logInfo } from "../logging/logger.js";

export interface ToolInfo {
  name: string;
  file?: string;
  command?: string;
  pattern?: string;
}

export interface ClaudeResult {
  error?: string;
  errorCode?: ErrorCode;
  sessionId?: string;
  result?: string;
  tools: ToolInfo[];
  stopReason?: string | null;
  interrupted?: boolean;
  costUsd?: number;
  usage?: { inputTokens: number; outputTokens: number };
  durationMs?: number;
}

export interface ImageInput {
  mediaType: string;
  data: string;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export type ProgressEvent =
  | { type: "tool_use"; tool: ToolInfo }
  | { type: "tool_summary"; summary: string }
  | { type: "task_status"; taskId: string; status: string; summary: string }
  | {
      type: "file_diff";
      filePath?: string;
      originalFile: string;
      newString: string;
    }
  | { type: "tool_error"; error: string }
  | {
      type: "rate_limit";
      status: "allowed_warning" | "rejected";
      resetsAt?: number;
    }
  | { type: "todo"; todos: TodoItem[] }
  | { type: "text"; text: string }
  | { type: "auth_error"; error: string }
  | { type: "done"; promptSuggestion?: string };

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

import { ERROR_CODES } from "../errors/error-codes.js";

/** Classify error message to structured error code. */
export function classifyErrorCode(message: string): ErrorCode | undefined {
  const lower = message.toLowerCase();

  if (message.includes("Session not found")) {
    return ERROR_CODES.CLAUDE_SESSION_NOT_FOUND;
  }
  if (message.includes("ENOENT")) {
    return ERROR_CODES.CLAUDE_CLI_NOT_FOUND;
  }
  if (
    lower.includes("auth") ||
    lower.includes("unauthorized") ||
    lower.includes("login") ||
    lower.includes("credential") ||
    message.includes("OAuth")
  ) {
    return ERROR_CODES.CLAUDE_AUTH_REQUIRED;
  }
  if (
    lower.includes("rate_limit") ||
    lower.includes("rate limit") ||
    lower.includes("rate-limit") ||
    message.includes("429")
  ) {
    return ERROR_CODES.CLAUDE_RATE_LIMITED;
  }
  if (lower.includes("context_length")) {
    return ERROR_CODES.CLAUDE_CONTEXT_TOO_LONG;
  }
  if (lower.includes("timeout") || message.includes("ETIMEDOUT")) {
    return ERROR_CODES.CLAUDE_TIMEOUT;
  }
  if (message.includes("exited with code 1")) {
    return ERROR_CODES.CLAUDE_PROCESS_FAILED;
  }

  return undefined;
}

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
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    logError("SESSION", "tmp_dir_create_failed", error, { dir });
    throw error;
  }

  const paths: string[] = [];
  for (const img of images) {
    const ext = EXT_MAP[img.mediaType] ?? ".png";
    const p = join(dir, `${randomUUID()}${ext}`);
    try {
      await writeFile(p, Buffer.from(img.data, "base64"));
    } catch (error) {
      logError("SESSION", "tmp_image_write_failed", error, {
        dir,
        mediaType: img.mediaType,
      });
      throw error;
    }
    paths.push(p);
  }
  logInfo("SESSION", "tmp_images_saved", { count: paths.length });
  return paths;
}
