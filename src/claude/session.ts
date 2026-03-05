import {
  query as sdkQuery,
  type CanUseTool,
  type PromptRequestOption,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../session/async-queue.js";
import type {
  ClaudeResult,
  ImageInput,
  ProgressEvent,
  PromptRequestInfo,
  ToolInfo,
  OnElicitation,
} from "./agent.js";
import { extractToolInfo, saveImagesToTmp } from "./agent.js";

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
}

// ─── Per-turn options ───

export interface TurnOptions {
  onProgress?: (event: ProgressEvent) => void;
  images?: ImageInput[];
}

// ─── ConversationSession ───

export class ConversationSession {
  private activeQuery: Query | null = null;
  private inputQueue: AsyncQueue<SDKUserMessage> | null = null;
  private sessionId: string | undefined;
  private _isBusy = false;
  private eventConsumer: Promise<void> | null = null;
  private turnResolver: TurnResolver | null = null;
  private _lastActivity = Date.now();
  private closed = false;
  private lastPromptSuggestion: string | undefined;

  constructor(private config: SessionConfig) {}

  get isBusy(): boolean {
    return this._isBusy;
  }
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
    return this.closed;
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
   * Send a message to the session. Blocks until the turn completes.
   * First call starts the query; subsequent calls use streamInput.
   */
  async send(
    prompt: string,
    turnOptions: TurnOptions = {},
  ): Promise<ClaudeResult> {
    if (this.closed) {
      return { error: "Session is closed", tools: [] };
    }

    this._isBusy = true;
    this._lastActivity = Date.now();
    const sendStart = Date.now();

    return new Promise<ClaudeResult>((resolve) => {
      const wrappedResolve = (result: ClaudeResult) => {
        console.log(
          `[SESSION] Turn completed in ${Date.now() - sendStart}ms (${this.activeQuery ? "queue push" : "new query"})`,
        );
        resolve(result);
      };
      this.turnResolver = {
        resolve: wrappedResolve,
        onProgress: turnOptions.onProgress,
        tools: [],
        streamingText: "",
      };

      if (!this.activeQuery) {
        this.startQuery(prompt, turnOptions.images).catch((err) => {
          this.resolveCurrentTurn({
            error: err instanceof Error ? err.message : String(err),
            tools: [],
          });
        });
      } else {
        this.streamMessage(prompt, turnOptions.images);
      }
    });
  }

  /** Interrupt the current execution. */
  async interrupt(): Promise<void> {
    if (this.activeQuery) {
      await this.activeQuery.interrupt();
    }
  }

  /** Close the query and clean up. */
  close(): void {
    this.closed = true;
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
    if (this.turnResolver) {
      this.turnResolver.resolve({
        error: "Session closed",
        tools: this.turnResolver.tools,
      });
      this.turnResolver = null;
    }
    this.eventConsumer = null;
    this._isBusy = false;
  }

  // ─── Private ───

  private async startQuery(
    prompt: string,
    images?: ImageInput[],
  ): Promise<void> {
    console.log("[SESSION] Starting new query (first message)");
    const finalPrompt = await preparePrompt(prompt, images);
    const options = this.buildQueryOptions();

    // Create queue and push first message
    this.inputQueue = new AsyncQueue<SDKUserMessage>();
    this.inputQueue.push({
      type: "user",
      message: { role: "user", content: finalPrompt },
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
      this.closed = true;
      this.resolveCurrentTurn({
        error: err instanceof Error ? err.message : String(err),
        tools: this.turnResolver?.tools ?? [],
      });
    });
  }

  private async streamMessage(
    prompt: string,
    images?: ImageInput[],
  ): Promise<void> {
    console.log("[SESSION] Pushing message to input queue");
    const finalPrompt = await preparePrompt(prompt, images);

    this.inputQueue!.push({
      type: "user",
      message: { role: "user", content: finalPrompt },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? "",
    });
  }

  private async consumeEvents(): Promise<void> {
    for await (const message of this.activeQuery as AsyncIterable<SDKMessage>) {
      await this.processMessage(message as Record<string, unknown>);
    }

    // Query process exited (could be interrupt or crash)
    if (this.turnResolver) {
      const partialText = this.turnResolver.streamingText || undefined;
      this.resolveCurrentTurn({
        result: partialText,
        interrupted: true,
        tools: this.turnResolver.tools,
        sessionId: this.sessionId,
      });
    }
    this.activeQuery = null;
  }

  private async processMessage(msg: Record<string, unknown>): Promise<void> {
    // ── Init message ──
    if (
      msg.type === "system" &&
      msg.subtype === "init" &&
      typeof msg.session_id === "string"
    ) {
      this.sessionId = msg.session_id;
      this.config.onSessionId?.(this.sessionId);
    }

    // ── Auth status ──
    if (msg.type === "auth_status") {
      const error = msg.error as string | undefined;
      if (error) {
        console.error(`[SESSION] Auth error: ${error}`);
        this.turnResolver?.onProgress?.({ type: "auth_error", error });
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
        this.turnResolver?.onProgress?.({ type: "tool_use", tool: toolInfo });
      }
    }

    // ── Streaming text ──
    if (
      msg.type === "stream_event" &&
      msg.parent_tool_use_id === null &&
      this.turnResolver
    ) {
      const evt = msg.event as Record<string, unknown> | undefined;
      if (evt?.type === "content_block_delta") {
        const delta = evt.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          this.turnResolver.streamingText += delta.text;
          this.turnResolver.onProgress?.({
            type: "text",
            text: this.turnResolver.streamingText,
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
        this.turnResolver?.onProgress?.({
          type: "rate_limit",
          status: info.status,
          resetsAt: info.resetsAt as number | undefined,
        });
      }
    }

    // ── Tool use summary ──
    if (msg.type === "tool_use_summary" && typeof msg.summary === "string") {
      this.turnResolver?.onProgress?.({
        type: "tool_summary",
        summary: msg.summary,
      });
    }

    // ── User message (tool_use_result payloads from tool responses) ──
    if (msg.type === "user") {
      const toolUseResult = msg.tool_use_result;
      if (toolUseResult && typeof toolUseResult === "object") {
        const payload = toolUseResult as Record<string, unknown>;
        if (
          typeof payload.originalFile === "string" &&
          typeof payload.newString === "string"
        ) {
          this.turnResolver?.onProgress?.({
            type: "file_diff",
            filePath:
              typeof payload.filePath === "string"
                ? payload.filePath
                : typeof payload.file_path === "string"
                  ? payload.file_path
                  : undefined,
            originalFile: payload.originalFile,
            newString: payload.newString,
          });
        }
      } else if (typeof toolUseResult === "string" && toolUseResult.trim()) {
        this.turnResolver?.onProgress?.({
          type: "tool_error",
          error: toolUseResult,
        });
      }
    }

    // ── Task notifications (subagent background tasks) ──
    if (
      msg.type === "system" &&
      (msg.subtype === "task_notification" || msg.subtype === "task_started") &&
      typeof msg.task_id === "string"
    ) {
      const status =
        msg.subtype === "task_started"
          ? "started"
          : ((msg.status as string) ?? "unknown");
      const summary =
        (msg.summary as string) ?? (msg.description as string) ?? "";
      this.turnResolver?.onProgress?.({
        type: "task_status",
        taskId: msg.task_id,
        status,
        summary,
      });
    }

    // ── Assistant message (collect tools, extract todos, reset streaming) ──
    if (msg.type === "assistant" && this.turnResolver) {
      this.turnResolver.streamingText = "";
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
                this.turnResolver.onProgress?.({
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
            this.turnResolver.tools.push(
              extractToolInfo(
                (b.name as string) ?? "unknown",
                b.input as Record<string, unknown> | undefined,
              ),
            );
          }
        }
      }
    }

    // ── Prompt suggestion ──
    if (msg.type === "prompt_suggestion" && typeof msg.prompt === "string") {
      this.lastPromptSuggestion = msg.prompt;
    }

    // ── Result ──
    if (msg.type === "result") {
      this.turnResolver?.onProgress?.({
        type: "done",
        promptSuggestion: this.lastPromptSuggestion,
      });
      this.lastPromptSuggestion = undefined;

      const stopReason = (msg.stop_reason as string | null) ?? null;

      // Interrupt result — return partial work, not an error
      if (
        msg.subtype === "interrupt" ||
        (msg as Record<string, unknown>).is_interrupt === true
      ) {
        const partialText =
          (msg.result as string) ||
          this.turnResolver?.streamingText ||
          undefined;
        this.resolveCurrentTurn({
          sessionId: this.sessionId,
          result: partialText,
          interrupted: true,
          tools: this.turnResolver?.tools ?? [],
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
        this.resolveCurrentTurn({
          error: errorMsg,
          sessionId: this.sessionId,
          tools: this.turnResolver?.tools ?? [],
          stopReason,
        });
        return;
      }

      const usage = msg.usage as
        | { input_tokens: number; output_tokens: number }
        | undefined;
      this.resolveCurrentTurn({
        sessionId: this.sessionId,
        result: (msg.result as string) ?? "",
        tools: this.turnResolver?.tools ?? [],
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
      this.resolveCurrentTurn({
        sessionId: this.sessionId,
        result: msg.result as string,
        tools: this.turnResolver?.tools ?? [],
      });
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

  private resolveCurrentTurn(result: ClaudeResult): void {
    this._isBusy = false;
    this._lastActivity = Date.now();
    if (this.turnResolver) {
      const resolver = this.turnResolver;
      this.turnResolver = null;
      resolver.resolve(result);
    }
  }

  private buildQueryOptions(): Record<string, unknown> {
    const opts: Record<string, unknown> = {
      allowedTools: this.config.allowedTools ?? [
        "Read",
        "Glob",
        "Grep",
        "AskUserQuestion",
      ],
      permissionMode: this.config.permissionMode ?? "default",
      allowDangerouslySkipPermissions:
        this.config.permissionMode === "bypassPermissions",
      maxTurns: this.config.maxTurns ?? 50,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append:
          "You are running inside Microsoft Teams as a bot. Keep responses concise and use markdown formatting compatible with Teams.",
      },
      executable: "node",
      settingSources: ["project"],
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

interface TurnResolver {
  resolve: (result: ClaudeResult) => void;
  onProgress?: (event: ProgressEvent) => void;
  tools: ToolInfo[];
  streamingText: string;
}

async function preparePrompt(
  prompt: string,
  images?: ImageInput[],
): Promise<string> {
  if (!images || images.length === 0) return prompt;

  const paths = await saveImagesToTmp(images);
  const imageRefs = paths.map((p) => `[Uploaded image: ${p}]`).join("\n");
  return `The user sent the following image(s). Use the Read tool to view them:\n${imageRefs}\n\n${prompt}`;
}
