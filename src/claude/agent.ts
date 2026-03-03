import { query } from "@anthropic-ai/claude-agent-sdk";
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
}

export interface ImageInput {
  mediaType: string;
  data: string;
}

export interface ProgressEvent {
  type: "tool_use";
  tool: ToolInfo;
}

export interface RunClaudeOptions {
  resume?: "fork" | "continue";
}

const EXT_MAP: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

async function saveImagesToTmp(images: ImageInput[]): Promise<string[]> {
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

export async function runClaude(
  prompt: string,
  sessionId?: string,
  workDir?: string,
  model?: string,
  thinkingTokens?: number | null,
  permissionMode?: string,
  images?: ImageInput[],
  onProgress?: (event: ProgressEvent) => void,
  runOptions?: RunClaudeOptions,
): Promise<ClaudeResult> {
  const tools: ToolInfo[] = [];
  let resultText: string | undefined;
  let newSessionId: string | undefined;

  try {
    const options: Record<string, unknown> = {
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      permissionMode: permissionMode ?? "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 50,
      executable: process.execPath,
    };

    if (model) options.model = model;
    if (thinkingTokens !== undefined && thinkingTokens !== null) {
      options.maxThinkingTokens = thinkingTokens;
    }
    if (sessionId) {
      options.resume = sessionId;
      if (runOptions?.resume === "fork") {
        options.forkSession = true;
      }
    } else {
      if (workDir) options.cwd = workDir;
    }

    // Save images to tmp files and prepend paths to prompt
    let finalPrompt = prompt;
    if (images && images.length > 0) {
      const paths = await saveImagesToTmp(images);
      const imageRefs = paths.map((p) => `[Uploaded image: ${p}]`).join("\n");
      finalPrompt = `The user sent the following image(s). Use the Read tool to view them:\n${imageRefs}\n\n${prompt}`;
    }

    for await (const message of query({ prompt: finalPrompt, options })) {
      // Capture session ID from init message
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        (message as Record<string, unknown>).type === "system" &&
        "subtype" in message &&
        (message as Record<string, unknown>).subtype === "init" &&
        "session_id" in message
      ) {
        newSessionId = (message as Record<string, unknown>)
          .session_id as string;
      }

      // tool_progress events
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        (message as Record<string, unknown>).type === "tool_progress"
      ) {
        const progress = message as Record<string, unknown>;
        const toolName = progress.tool as string | undefined;
        if (toolName) {
          const toolInfo: ToolInfo = { name: toolName };
          const input = progress.input as Record<string, unknown> | undefined;
          if (input) {
            if (typeof input.file_path === "string")
              toolInfo.file = input.file_path;
            if (typeof input.command === "string") {
              toolInfo.command = input.command.slice(0, 100);
            }
            if (typeof input.pattern === "string")
              toolInfo.pattern = input.pattern;
          }
          onProgress?.({ type: "tool_use", tool: toolInfo });
        }
      }

      // Collect tool usage from assistant messages
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        (message as Record<string, unknown>).type === "assistant"
      ) {
        const msg = message as Record<string, unknown>;
        const inner = msg.message as Record<string, unknown> | undefined;
        const content = inner?.content ?? msg.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              typeof block === "object" &&
              block !== null &&
              "type" in block &&
              (block as Record<string, unknown>).type === "tool_use"
            ) {
              const b = block as Record<string, unknown>;
              const toolInfo: ToolInfo = {
                name: (b.name as string) ?? "unknown",
              };
              const input = b.input as Record<string, unknown> | undefined;
              if (input) {
                if (typeof input.file_path === "string")
                  toolInfo.file = input.file_path;
                if (typeof input.command === "string")
                  toolInfo.command = input.command.slice(0, 100);
                if (typeof input.pattern === "string")
                  toolInfo.pattern = input.pattern;
              }
              tools.push(toolInfo);
            }
          }
        }
      }

      // Capture final result
      if (
        typeof message === "object" &&
        message !== null &&
        "result" in message
      ) {
        resultText = (message as Record<string, unknown>).result as string;
      }
    }

    return {
      sessionId: newSessionId,
      result: resultText ?? "",
      tools,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[CLAUDE] Error: ${errorMessage}`);
    console.error(
      `[CLAUDE] Options: sessionId=${sessionId}, workDir=${workDir}, resume=${!!sessionId}`,
    );
    if (err instanceof Error && err.stack) {
      console.error(`[CLAUDE] Stack: ${err.stack}`);
    }
    return {
      error: errorMessage.slice(0, 500),
      tools,
    };
  }
}
