import {
  query as sdkQuery,
  type CanUseTool,
  type PromptRequestOption,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { join, dirname, resolve } from "path";
import { readFile } from "fs/promises";
import { AsyncQueue } from "../session/async-queue.js";
import type {
  ClaudeResult,
  ProgressEvent,
  PromptRequestInfo,
  ToolInfo,
  OnElicitation,
} from "./agent.js";
import { extractToolInfo } from "./agent.js";

/** MessageParam content — string or array of content blocks. */
export type MessageContent = string | Record<string, unknown>[];

// Resolve cli.js path explicitly. process.argv[1] is the entry file (dist/index.js or
// src/index.ts), always one directory below the project root, so dirname x2 = root.
const CLAUDE_CLI_PATH = join(
  dirname(dirname(resolve(process.argv[1]))),
  "node_modules",
  "@anthropic-ai",
  "claude-agent-sdk",
  "cli.js",
);

// ─── Session config (set once at creation) ───

export interface SessionConfig {
  cwd?: string;
  model?: string;
  thinkingTokens?: number | null;
  permissionMode?: string;
  allowedTools?: string[];
  maxTurns?: number;

  // Resume a previous session (e.g. handoff from terminal)
  resume?: string;
  forkSession?: boolean;

  // SDK callbacks — closures over mutable ctx, set once
  canUseTool?: CanUseTool;
  onElicitation?: OnElicitation;

  // App-level callbacks
  onPromptRequest?: (info: PromptRequestInfo) => Promise<string>;
  onSessionId?: (sessionId: string) => void;
  onResumeInvalid?: () => void | Promise<void>;

  // Event callbacks — session pushes events, bot layer handles UI
  onProgress?: (event: ProgressEvent) => void;
  onResult?: (result: ClaudeResult) => void | Promise<void>;
}

// ─── ConversationSession ───

export class ConversationSession {
  private activeQuery: Query | null = null;
  private inputQueue: AsyncQueue<SDKUserMessage> | null = null;
  private sessionId: string | undefined;
  private eventConsumer: Promise<void> | null = null;
  private _lastActivity = Date.now();

  // Per-turn tracking (reset on each result)
  private turnTools: ToolInfo[] = [];
  private turnStreamingText = "";
  private resumeRetryAttempted = false;
  // Map tool_use_id → file_path for Read tool calls (used to send original images)
  private readToolPaths = new Map<string, string>();
  private pendingRetry: { content: MessageContent } | undefined = undefined;
  private lastStartPayload: { content: MessageContent } | undefined = undefined;

  constructor(private config: SessionConfig) {}

  get hasQuery(): boolean {
    return this.activeQuery !== null;
  }
  get lastActivityTime(): number {
    return this._lastActivity;
  }
  get currentSessionId(): string | undefined {
    return this.sessionId;
  }
  get isClosed(): boolean {
    return this.activeQuery === null && this.inputQueue === null;
  }

  /** Get SDK slash commands (available only after query is started). */
  async getSupportedCommands(): Promise<
    Array<{ name: string; description: string }> | undefined
  > {
    if (!this.activeQuery) return undefined;
    try {
      return await this.activeQuery.supportedCommands();
    } catch {
      return undefined;
    }
  }

  /** Dynamically change permission mode on the running query. */
  async setPermissionMode(mode: string): Promise<void> {
    if (this.activeQuery) {
      await this.activeQuery.setPermissionMode(
        mode as Parameters<Query["setPermissionMode"]>[0],
      );
    }
  }

  /** Dynamically change model on the running query. */
  async setModel(model?: string): Promise<void> {
    if (this.activeQuery) {
      await this.activeQuery.setModel(model);
    }
  }

  /** Stop a background subagent task by ID. */
  async stopTask(taskId: string): Promise<void> {
    if (this.activeQuery) {
      await this.activeQuery.stopTask(taskId);
    }
  }

  /**
   * Send a message to the session (fire-and-forget).
   * First call starts the query; subsequent calls push to the SDK's internal queue.
   * Results are delivered via config.onResult callback.
   */
  send(content: MessageContent): void {
    this._lastActivity = Date.now();

    if (!this.activeQuery) {
      this.startQuery(content).catch((err) => {
        this.emitResult({
          error: err instanceof Error ? err.message : String(err),
          tools: [],
        });
      });
    } else {
      // Don't reset turn state — SDK is still processing the current turn
      this.streamMessage(content);
    }
  }

  /** Interrupt the current execution. */
  async interrupt(): Promise<void> {
    if (this.activeQuery) {
      await this.activeQuery.interrupt();
    }
  }

  /** Close the query and clean up. */
  close(): void {
    if (this.inputQueue) {
      this.inputQueue.end();
      this.inputQueue = null;
    }
    if (this.activeQuery) {
      try {
        this.activeQuery.close();
      } catch {
        // Ignore close errors (query may already be dead)
      }
      this.activeQuery = null;
    }
    this.eventConsumer = null;
  }

  // ─── Private ───

  private resetTurnState(): void {
    this.turnTools = [];
    this.turnStreamingText = "";
    this.readToolPaths.clear();
  }

  private emitProgress(event: ProgressEvent): void {
    this.config.onProgress?.(event);
  }

  private async emitResult(result: ClaudeResult): Promise<void> {
    this._lastActivity = Date.now();
    this.resetTurnState();
    await this.config.onResult?.(result);
  }


  private async startQuery(content: MessageContent): Promise<void> {
    this.lastStartPayload = { content };
    console.log("[SESSION] Starting new query (first message)");
    const options = this.buildQueryOptions();

    // Create queue and push first message
    this.inputQueue = new AsyncQueue<SDKUserMessage>();
    this.inputQueue.push({
      type: "user",
      // Cast needed: SDK types MessageParam.content as string, but the CLI
      // accepts content block arrays (image/document/text) per the Messages API.
      message: { role: "user", content } as never,
      parent_tool_use_id: null,
      session_id: "",
    });

    // Pass async generator as prompt — SDK reads messages from the queue
    const queue = this.inputQueue;
    async function* promptGenerator() {
      yield* queue;
    }

    this.activeQuery = sdkQuery({ prompt: promptGenerator(), options });

    this.eventConsumer = this.consumeEvents().catch((err) => {
      console.error("[SESSION] Event consumer error:", err);
      this.activeQuery = null;
      this.emitResult({
        error: err instanceof Error ? err.message : String(err),
        tools: [...this.turnTools],
      });
    });
  }

  private streamMessage(content: MessageContent): void {
    console.log("[SESSION] Pushing message to input queue");

    this.inputQueue!.push({
      type: "user",
      // Cast needed: SDK types MessageParam.content as string, but the CLI
      // accepts content block arrays (image/document/text) per the Messages API.
      message: { role: "user", content } as never,
      parent_tool_use_id: null,
      session_id: this.sessionId ?? "",
    });
  }

  private async consumeEvents(): Promise<void> {
    for await (const message of this.activeQuery as AsyncIterable<SDKMessage>) {
      await this.processMessage(message as Record<string, unknown>);
    }
    // SDK always sends a result event before the iterator ends.
    // Crashes are caught by the .catch() on eventConsumer.
    this.activeQuery = null;
    if (this.inputQueue) {
      this.inputQueue.end();
      this.inputQueue = null;
    }

    if (this.pendingRetry) {
      const retry = this.pendingRetry;
      this.pendingRetry = undefined;
      await this.startQuery(retry.content);
    }
  }

  private async processMessage(msg: Record<string, unknown>): Promise<void> {
    const msgType = msg.type as string | undefined;
    const msgSubtype = msg.subtype as string | undefined;
    const extra =
      msgType === "system" && msgSubtype === "status"
        ? ` status=${msg.status}`
        : msgType === "result"
          ? ` subtype=${msgSubtype}`
          : msgType === "stream_event"
            ? ` evt=${(msg.event as Record<string, unknown> | undefined)?.type}`
            : "";
    console.log(`[SESSION] msg: type=${msgType} subtype=${msgSubtype}${extra}`);

    // ── Init message ──
    if (
      msg.type === "system" &&
      msg.subtype === "init" &&
      typeof msg.session_id === "string"
    ) {
      this.sessionId = msg.session_id;
      this.config.onSessionId?.(this.sessionId);
    }

    // ── Status changes (compacting, etc.) ──
    // SDK sends status: 'compacting' when starting, status: null when done.
    if (msg.type === "system" && msg.subtype === "status") {
      const status = typeof msg.status === "string" ? msg.status : "idle";
      this.emitProgress({ type: "status", status });
    }

    // ── Local command output (e.g. /compact, /cost — SDK-handled slash commands) ──
    if (
      msg.type === "system" &&
      msg.subtype === "local_command_output" &&
      typeof msg.content === "string"
    ) {
      this.emitProgress({ type: "text", text: msg.content });
    }

    // ── Auth status ──
    if (msg.type === "auth_status") {
      const error = msg.error as string | undefined;
      if (error) {
        console.error(`[SESSION] Auth error: ${error}`);
        this.emitProgress({ type: "auth_error", error });
      }
    }

    // ── PromptRequest ──
    if ("prompt" in msg && "message" in msg && "options" in msg) {
      await this.handlePromptRequest(msg);
      return;
    }

    // ── tool_progress ──
    if (msg.type === "tool_progress") {
      const toolName =
        (msg.tool_name as string | undefined) ??
        (msg.tool as string | undefined);
      if (toolName) {
        const toolInfo = extractToolInfo(
          toolName,
          msg.input as Record<string, unknown> | undefined,
        );
        this.emitProgress({ type: "tool_use", tool: toolInfo });
      }
    }

    // ── Streaming text ──
    if (msg.type === "stream_event" && msg.parent_tool_use_id === null) {
      const evt = msg.event as Record<string, unknown> | undefined;
      if (evt?.type === "message_start") {
        this.emitProgress({ type: "started" });
      }
      if (evt?.type === "content_block_delta") {
        const delta = evt.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          this.turnStreamingText += delta.text;
          this.emitProgress({
            type: "text",
            text: delta.text,
          });
        }
        if (
          delta?.type === "thinking_delta" &&
          typeof delta.thinking === "string"
        ) {
          this.emitProgress({
            type: "thinking",
            text: delta.thinking,
          });
        }
      }
    }

    // ── Rate limit event (claude.ai subscription users) ──
    if (msg.type === "rate_limit_event") {
      const info = msg.rate_limit_info as Record<string, unknown> | undefined;
      if (
        info &&
        (info.status === "allowed_warning" || info.status === "rejected")
      ) {
        this.emitProgress({
          type: "rate_limit",
          status: info.status,
          resetsAt: info.resetsAt as number | undefined,
        });
      }
    }

    // ── Tool use summary ──
    if (msg.type === "tool_use_summary" && typeof msg.summary === "string") {
      this.emitProgress({
        type: "tool_summary",
        summary: msg.summary,
      });
    }

    // ── User message (tool_use_result payloads from tool responses) ──
    if (msg.type === "user") {
      const toolUseResult = msg.tool_use_result;

      // Skip tool errors — Claude handles retries internally, no need to show raw errors to user
      const inner = msg.message as Record<string, unknown> | undefined;
      const contentBlocks = Array.isArray(inner?.content)
        ? (inner!.content as Array<Record<string, unknown>>)
        : [];
      const isToolError = contentBlocks.some((b) => b.is_error === true);
      if (isToolError) {
        // Claude sees the error and retries with adjusted params; don't surface to user
        return;
      }

      if (toolUseResult && typeof toolUseResult === "object") {
        const payload = toolUseResult as Record<string, unknown>;
        // FileReadOutput — image type (screenshots, image file reads)
        if (payload.type === "image" && payload.file) {
          await this.emitImageFromFileRead(payload, msg);
        }

        // BashOutput — isImage flag (command output screenshots)
        if (
          payload.isImage === true &&
          typeof payload.stdout === "string" &&
          payload.stdout.length > 0
        ) {
          const b64 = payload.stdout;
          this.emitProgress({
            type: "image",
            base64: b64,
            mimeType: "image/png",
            sizeBytes: Math.ceil(b64.length * 3 / 4),
          });
        }

        // FileEditOutput or FileWriteOutput — extract gitDiff.patch or structuredPatch
        if (
          typeof payload.filePath === "string" &&
          (payload.gitDiff || payload.structuredPatch)
        ) {
          const gitDiff = payload.gitDiff as { patch?: string } | undefined;
          let patch = gitDiff?.patch;
          if (!patch && Array.isArray(payload.structuredPatch)) {
            // Build patch from structuredPatch hunks
            const hunks = payload.structuredPatch as Array<{
              lines: string[];
            }>;
            const lines = hunks.flatMap((h) => h.lines);
            if (lines.length > 0) patch = lines.join("\n");
          }
          this.emitProgress({
            type: "file_diff",
            filePath: payload.filePath as string,
            patch,
          });
        }
      } else if (typeof toolUseResult === "string" && toolUseResult.trim()) {
        this.emitProgress({
          type: "tool_result",
          result: toolUseResult,
        });
      }
    }

    // ── Task notifications (subagent background tasks) ──
    if (
      msg.type === "system" &&
      (msg.subtype === "task_notification" ||
        msg.subtype === "task_started" ||
        msg.subtype === "task_progress") &&
      typeof msg.task_id === "string"
    ) {
      const status =
        msg.subtype === "task_started"
          ? "started"
          : msg.subtype === "task_progress"
            ? "in_progress"
            : ((msg.status as string) ?? "unknown");
      const summary =
        (msg.summary as string) ?? (msg.description as string) ?? "";
      this.emitProgress({
        type: "task_status",
        taskId: msg.task_id,
        status,
        summary,
      });
    }

    // ── Assistant message (collect tools, extract todos, reset streaming) ──
    if (msg.type === "assistant") {
      this.turnStreamingText = "";
      const inner = msg.message as Record<string, unknown> | undefined;
      const content = inner?.content ?? msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block
          ) {
            const blockType = (block as Record<string, unknown>).type;

            if (blockType !== "tool_use") continue;
            const b = block as Record<string, unknown>;
            // Emit todo updates
            if (
              b.name === "TodoWrite" ||
              b.name === "TaskCreate" ||
              b.name === "TaskUpdate"
            ) {
              const input = b.input as Record<string, unknown> | undefined;
              const todos = input?.todos as
                | Array<Record<string, unknown>>
                | undefined;
              if (Array.isArray(todos)) {
                this.emitProgress({
                  type: "todo",
                  todos: todos.map((t) => ({
                    content:
                      (t.content as string) ?? (t.subject as string) ?? "",
                    status:
                      (t.status as "pending" | "in_progress" | "completed") ??
                      "pending",
                    activeForm: t.activeForm as string | undefined,
                  })),
                });
              }
            }
            // Track Read tool file paths for original image forwarding
            if (b.name === "Read" || b.name === "FileRead") {
              const input = b.input as Record<string, unknown> | undefined;
              const filePath = input?.file_path as string | undefined;
              const toolId = b.id as string | undefined;
              if (filePath && toolId) {
                this.readToolPaths.set(toolId, filePath);
              }
            }
            const toolInfo = extractToolInfo(
              (b.name as string) ?? "unknown",
              b.input as Record<string, unknown> | undefined,
            );
            this.emitProgress({ type: "tool_use", tool: toolInfo });
            this.turnTools.push(toolInfo);
          }
        }
      }
    }

    // ── Prompt suggestion (arrives after result) ──
    if (msg.type === "prompt_suggestion") {
      const suggestion = (msg.suggestion ?? msg.prompt) as string | undefined;
      if (typeof suggestion === "string") {
        this.emitProgress({ type: "prompt_suggestion", suggestion });
      }
      return;
    }

    // ── Result ──
    if (msg.type === "result") {
      this.emitProgress({ type: "done" });

      const stopReason = (msg.stop_reason as string | null) ?? null;

      // Interrupt result — return partial work, not an error
      if (
        msg.subtype === "interrupt" ||
        (msg as Record<string, unknown>).is_interrupt === true
      ) {
        const partialText =
          (msg.result as string) || this.turnStreamingText || undefined;
        await this.emitResult({
          sessionId: this.sessionId,
          result: partialText,
          interrupted: true,
          tools: [...this.turnTools],
          stopReason,
        });
        return;
      }

      const isError =
        msg.is_error === true ||
        (typeof msg.subtype === "string" &&
          (msg.subtype as string).startsWith("error_"));

      if (isError) {
        const errors = msg.errors as string[] | undefined;
        const errorMsg =
          errors && errors.length > 0
            ? errors.join("; ")
            : `Error: ${msg.subtype ?? "unknown"}`;

        const shouldRetryWithoutResume =
          !this.resumeRetryAttempted &&
          !!this.config.resume &&
          !!this.lastStartPayload &&
          isResumeFailure(errorMsg);

        if (shouldRetryWithoutResume) {
          console.warn(
            "[SESSION] Resume failed, retrying with a fresh session in the same workDir",
          );
          this.resumeRetryAttempted = true;
          this.config.resume = undefined;
          this.config.forkSession = undefined;
          await this.config.onResumeInvalid?.();
          this.pendingRetry = this.lastStartPayload;
          return;
        }

        await this.emitResult({
          error: errorMsg,
          sessionId: this.sessionId,
          tools: [...this.turnTools],
          stopReason,
        });
        return;
      }

      const usage = msg.usage as
        | { input_tokens: number; output_tokens: number }
        | undefined;
      await this.emitResult({
        sessionId: this.sessionId,
        result: (msg.result as string) ?? "",
        tools: [...this.turnTools],
        stopReason,
        costUsd: (msg.total_cost_usd as number) ?? undefined,
        durationMs: (msg.duration_ms as number) ?? undefined,
        usage: usage
          ? {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
            }
          : undefined,
      });
    }

    // ── Legacy result (no type field) ──
    if (!("type" in msg) && "result" in msg) {
      await this.emitResult({
        sessionId: this.sessionId,
        result: msg.result as string,
        tools: [...this.turnTools],
      });
    }
  }

  /** Extract and emit an image from a FileReadOutput tool result.
   *  Tries to read the original file for full quality; falls back to the SDK's resized version. */
  private async emitImageFromFileRead(
    payload: Record<string, unknown>,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const file = payload.file as Record<string, unknown>;
    const mimeType = file.type as string | undefined;
    if (!mimeType) return;

    const sdkBase64 = file.base64 as string | undefined;
    if (typeof sdkBase64 !== "string") return;

    const sdkSizeBytes = (file.originalSize as number) ?? Math.ceil(sdkBase64.length * 3 / 4);

    // Find the original file path from the Read tool call.
    // parent_tool_use_id is typically null; the real ID is inside
    // msg.message.content[].tool_use_id (ToolResultBlockParam).
    const toolId =
      (msg.parent_tool_use_id as string | undefined) ??
      (Array.isArray((msg.message as Record<string, unknown> | undefined)?.content)
        ? ((msg.message as Record<string, unknown>).content as Array<Record<string, unknown>>)
            .find((b) => b.type === "tool_result" && typeof b.tool_use_id === "string")
            ?.tool_use_id as string | undefined
        : undefined);
    const originalPath = toolId ? this.readToolPaths.get(toolId) : undefined;

    if (!originalPath) {
      this.emitProgress({ type: "image", base64: sdkBase64, mimeType, sizeBytes: sdkSizeBytes });
      return;
    }

    try {
      // Resolve POSIX-style /c/... paths to Windows C:\... on win32
      let fsPath = originalPath;
      if (process.platform === "win32" && /^\/[a-zA-Z]\//.test(fsPath)) {
        fsPath = fsPath[1].toUpperCase() + ":" + fsPath.slice(2).replace(/\//g, "\\");
      }
      const buf = await readFile(fsPath);
      this.emitProgress({
        type: "image",
        base64: buf.toString("base64"),
        mimeType,
        name: originalPath.split(/[/\\]/).pop(),
        sizeBytes: buf.length,
      });
    } catch (err) {
      console.warn("[SESSION] Could not read original image, using SDK version:", err);
      this.emitProgress({ type: "image", base64: sdkBase64, mimeType, sizeBytes: sdkSizeBytes });
    }
  }

  private async handlePromptRequest(
    msg: Record<string, unknown>,
  ): Promise<void> {
    if (!this.config.onPromptRequest) return;

    const req = msg as {
      prompt: string;
      message: string;
      options: PromptRequestOption[];
    };

    const selected = await this.config.onPromptRequest({
      requestId: req.prompt,
      message: req.message,
      options: req.options,
    });

    // Send response back via input queue
    if (this.inputQueue) {
      this.inputQueue.push({
        prompt_response: req.prompt,
        selected,
      } as unknown as SDKUserMessage);
    }
  }

  private buildQueryOptions(): Record<string, unknown> {
    const opts: Record<string, unknown> = {
      allowedTools: this.config.allowedTools ?? [
        "Read",
        "Glob",
        "Grep",
        "AskUserQuestion",
        "Skill",
      ],
      permissionMode: this.config.permissionMode ?? "default",
      allowDangerouslySkipPermissions: true,
      maxTurns: this.config.maxTurns ?? 200,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append:
          "You are running inside Microsoft Teams as a bot. Keep responses concise and use markdown formatting compatible with Teams.\n\nIMPORTANT: When a tool permission is denied, tell the user briefly which tool was denied and why, in your own words. NEVER forward the raw error message or internal SDK instructions to the user. Keep denial messages short and user-friendly.",
      },
      executable: process.argv[0],
      pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
      promptSuggestions: true,
      env: { ...process.env, CLAUDECODE: undefined },
    };

    if (this.config.model) opts.model = this.config.model;
    if (this.config.thinkingTokens !== undefined) {
      if (this.config.thinkingTokens === null) {
        opts.thinking = { type: "disabled" };
      } else {
        opts.thinking = {
          type: "enabled",
          budgetTokens: this.config.thinkingTokens,
        };
      }
    }
    if (this.config.cwd) opts.cwd = this.config.cwd;
    if (this.config.resume) {
      opts.resume = this.config.resume;
      if (this.config.forkSession) opts.forkSession = true;
    }
    if (this.config.canUseTool) opts.canUseTool = this.config.canUseTool;
    if (this.config.onElicitation)
      opts.onElicitation = this.config.onElicitation;

    return opts;
  }
}

// ─── Helpers ───

function isResumeFailure(error: string): boolean {
  const msg = error.toLowerCase();
  return (
    msg.includes("no conversation found with session id") ||
    msg.includes("session not found") ||
    msg.includes("--resume")
  );
}
