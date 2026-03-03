import { query } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir, homedir } from "os";
import { readdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";

/** Find the jsonl file path for a session. */
export function findSessionFile(
  sessionId: string,
  projectsDir = join(homedir(), ".claude", "projects"),
): string | undefined {
  if (!existsSync(projectsDir)) return undefined;

  for (const dir of readdirSync(projectsDir)) {
    const sessionFile = join(projectsDir, dir, `${sessionId}.jsonl`);
    if (existsSync(sessionFile)) return sessionFile;
  }
  return undefined;
}

/** Find the cwd for a session by scanning its jsonl file for the cwd field. */
export function findSessionCwd(
  sessionId: string,
  projectsDir = join(homedir(), ".claude", "projects"),
): string | undefined {
  const file = findSessionFile(sessionId, projectsDir);
  if (!file) return undefined;

  try {
    const chunk = readFileSync(file, "utf-8").slice(0, 10000);
    for (const line of chunk.split("\n")) {
      if (!line.includes('"cwd"')) continue;
      const data = JSON.parse(line);
      if (data.cwd) return data.cwd;
    }
  } catch {}
  return undefined;
}

const MAX_SUMMARY_CHARS = 4000;

/** Extract a conversation summary from a session's transcript. */
export function getSessionSummary(
  sessionId: string,
  projectsDir = join(homedir(), ".claude", "projects"),
): string | undefined {
  const file = findSessionFile(sessionId, projectsDir);
  if (!file) return undefined;

  try {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    const messages: Array<{ role: string; text: string }> = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);

        // User messages (string or array content)
        if (data.type === "user") {
          if (typeof data.message?.content === "string") {
            messages.push({ role: "user", text: data.message.content });
          } else if (Array.isArray(data.message?.content)) {
            const textParts: string[] = [];
            for (const block of data.message.content) {
              if (block.type === "text" && typeof block.text === "string") {
                textParts.push(block.text);
              }
            }
            if (textParts.length > 0) {
              messages.push({ role: "user", text: textParts.join("\n") });
            }
          }
        }

        // Assistant messages — only extract text blocks, skip tool_use
        if (data.type === "assistant" && Array.isArray(data.message?.content)) {
          const textParts: string[] = [];
          for (const block of data.message.content) {
            if (block.type === "text" && typeof block.text === "string") {
              textParts.push(block.text);
            }
          }
          if (textParts.length > 0) {
            messages.push({ role: "assistant", text: textParts.join("\n") });
          }
        }
      } catch {}
    }

    if (messages.length === 0) return undefined;

    // Take the last ~10 messages
    const recent = messages.slice(-10);
    let summary = recent
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
      .join("\n\n");

    // Truncate
    if (summary.length > MAX_SUMMARY_CHARS) {
      summary = "..." + summary.slice(-MAX_SUMMARY_CHARS);
    }

    return summary;
  } catch {}
  return undefined;
}


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
      const sessionCwd = findSessionCwd(sessionId);
      if (!sessionCwd) {
        return { error: `Session not found: ${sessionId}`, tools };
      }
      options.resume = sessionId;
      options.cwd = sessionCwd;
    } else {
      if (workDir) options.cwd = workDir;
    }

    // Save images to tmp files and prepend paths to prompt
    let finalPrompt = prompt;
    if (images && images.length > 0) {
      const paths = await saveImagesToTmp(images);
      const imageRefs = paths
        .map((p) => `[Uploaded image: ${p}]`)
        .join("\n");
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
              onProgress?.({ type: "tool_use", tool: toolInfo });
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
    const errorMessage =
      err instanceof Error ? err.message : String(err);
    console.error(`[CLAUDE] Error: ${errorMessage}`);
    console.error(`[CLAUDE] Options: sessionId=${sessionId}, workDir=${workDir}, resume=${!!sessionId}`);
    if (err instanceof Error && err.stack) {
      console.error(`[CLAUDE] Stack: ${err.stack}`);
    }
    return {
      error: errorMessage.slice(0, 500),
      tools,
    };
  }
}
