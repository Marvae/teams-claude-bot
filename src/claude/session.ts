import {
  query as sdkQuery,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { join, dirname, resolve } from "path";
import { processMessage, type EventProcessorState } from "./event-processor.js";
import { saveImagesToTmp, classifyErrorCode } from "./types.js";
import type {
  CanUseTool,
  ClaudeResult,
  ImageInput,
  OnElicitation,
  ProgressEvent,
  PromptRequestInfo,
} from "./types.js";
import { AppError } from "../errors/app-error.js";
import { ERROR_CODES, type ErrorCode } from "../errors/error-codes.js";
import { logError, logInfo } from "../logging/logger.js";

// Resolve cli.js path explicitly. process.argv[1] is the entry file (dist/index.js or
// src/index.ts), always one directory below the project root, so dirname x2 = root.
const CLAUDE_CLI_PATH = join(
  dirname(dirname(resolve(process.argv[1]))),
  "node_modules",
  "@anthropic-ai",
  "claude-agent-sdk",
  "cli.js",
);

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

  // Event callbacks — session pushes events, bot layer handles UI
  onProgress?: (event: ProgressEvent) => void;
  onResult?: (result: ClaudeResult) => void | Promise<void>;
}

export class ConversationSession {
  private activeQuery: Query | null = null;
  private eventConsumer: Promise<void> | null = null;
  private _lastActivity = Date.now();
  private closed = false;

  private eventState: EventProcessorState = {
    turnTools: [],
    turnStreamingText: "",
  };

  constructor(private config: SessionConfig) {}

  get hasQuery(): boolean {
    return this.activeQuery !== null;
  }
  get lastActivityTime(): number {
    return this._lastActivity;
  }
  get currentSessionId(): string | undefined {
    return this.eventState.sessionId;
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
    } catch (error) {
      logError("SESSION", "supported_commands_failed", error, {
        sessionId: this.eventState.sessionId,
      });
      return undefined;
    }
  }

  /** Dynamically change permission mode on the running query. */
  async setPermissionMode(mode: string): Promise<void> {
    if (this.activeQuery) {
      try {
        await this.activeQuery.setPermissionMode(
          mode as Parameters<Query["setPermissionMode"]>[0],
        );
        logInfo("SESSION", "permission_mode_set", { mode });
      } catch (error) {
        throw new AppError(
          "SESSION",
          ERROR_CODES.SET_PERMISSION_MODE_FAILED,
          `Failed to set permission mode: ${mode}`,
          error,
        );
      }
    }
  }

  /** Dynamically change model on the running query. */
  async setModel(model?: string): Promise<void> {
    if (this.activeQuery) {
      try {
        await this.activeQuery.setModel(model);
        logInfo("SESSION", "model_set", { model: model ?? "default" });
      } catch (error) {
        throw new AppError(
          "SESSION",
          ERROR_CODES.SET_MODEL_FAILED,
          `Failed to set model: ${model ?? "default"}`,
          error,
        );
      }
    }
  }

  /** Stop a background subagent task by ID. */
  async stopTask(taskId: string): Promise<void> {
    if (this.activeQuery) {
      try {
        await this.activeQuery.stopTask(taskId);
        logInfo("SESSION", "task_stop_requested", { taskId });
      } catch (error) {
        throw new AppError(
          "SESSION",
          ERROR_CODES.STOP_TASK_FAILED,
          `Failed to stop task: ${taskId}`,
          error,
        );
      }
    }
  }

  /**
   * Send a message to the session (fire-and-forget).
   * First call starts the query; subsequent calls use streamInput().
   * Results are delivered via config.onResult callback.
   */
  send(prompt: string, images?: ImageInput[]): void {
    if (this.closed) {
      logInfo("SESSION", "send_rejected_closed");
      void this.config.onResult?.({
        error: "Session is closed",
        errorCode: ERROR_CODES.SESSION_CLOSED,
        tools: [],
      });
      return;
    }

    this._lastActivity = Date.now();

    if (!this.activeQuery) {
      this.startQuery(prompt, images).catch((err) => {
        logError("SESSION", "start_query_failed", err, {
          sessionId: this.eventState.sessionId,
        });
        const info = this.classifyError(err);
        void this.emitResult({
          error: info.message,
          errorCode: info.code,
          tools: [],
        });
      });
    } else {
      this.streamMessage(prompt, images).catch((err) => {
        logError("SESSION", "stream_message_failed", err, {
          sessionId: this.eventState.sessionId,
        });
        const info = this.classifyError(err);
        void this.emitResult({
          error: info.message,
          errorCode: info.code,
          tools: [...this.eventState.turnTools],
          sessionId: this.eventState.sessionId,
        });
      });
    }
  }

  /** Interrupt the current execution. */
  async interrupt(): Promise<void> {
    if (this.activeQuery) {
      try {
        await this.activeQuery.interrupt();
        logInfo("SESSION", "interrupt_requested", {
          sessionId: this.eventState.sessionId,
        });
      } catch (error) {
        throw new AppError(
          "SESSION",
          ERROR_CODES.INTERRUPT_FAILED,
          "Failed to interrupt active session",
          error,
        );
      }
    }
  }

  /** Close the query and clean up. */
  close(): void {
    this.closed = true;
    if (this.activeQuery) {
      try {
        this.activeQuery.close();
        logInfo("SESSION", "closed", { sessionId: this.eventState.sessionId });
      } catch (error) {
        logError("SESSION", "close_failed", error, {
          sessionId: this.eventState.sessionId,
        });
      }
      this.activeQuery = null;
    }
    this.eventConsumer = null;
  }

  private resetTurnState(): void {
    this.eventState.turnTools = [];
    this.eventState.turnStreamingText = "";
  }

  private emitProgress(event: ProgressEvent): void {
    this.config.onProgress?.(event);
  }

  private async emitResult(result: ClaudeResult): Promise<void> {
    this._lastActivity = Date.now();
    this.resetTurnState();
    try {
      await this.config.onResult?.(result);
    } catch (error) {
      logError("SESSION", "on_result_callback_failed", error, {
        sessionId: this.eventState.sessionId,
      });
    }
  }

  private async startQuery(
    prompt: string,
    images?: ImageInput[],
  ): Promise<void> {
    logInfo("SESSION", "query_start", {
      resume: this.config.resume ? "yes" : "no",
      cwd: this.config.cwd,
    });
    const finalPrompt = await preparePrompt(prompt, images);
    const options = this.buildQueryOptions();

    // Start query with string prompt (not AsyncIterable)
    this.activeQuery = sdkQuery({ prompt: finalPrompt, options });

    this.eventConsumer = this.consumeEvents().catch((err) => {
      logError("SESSION", "event_consumer_failed", err, {
        sessionId: this.eventState.sessionId,
      });
      this.closed = true;
      const info = this.classifyError(err);
      void this.emitResult({
        error: info.message,
        errorCode: info.code,
        tools: [...this.eventState.turnTools],
      });
    });
  }

  private async streamMessage(
    prompt: string,
    images?: ImageInput[],
  ): Promise<void> {
    if (!this.activeQuery) {
      throw new AppError(
        "SESSION",
        ERROR_CODES.STREAM_WITHOUT_QUERY,
        "Cannot stream message: active query is unavailable",
      );
    }
    logInfo("SESSION", "message_stream_start", {
      sessionId: this.eventState.sessionId,
    });
    const finalPrompt = await preparePrompt(prompt, images);

    // Use SDK's streamInput() for subsequent messages
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: finalPrompt },
      parent_tool_use_id: null,
      session_id: this.eventState.sessionId ?? "",
    };

    await this.activeQuery.streamInput(
      (async function* () {
        yield msg;
      })(),
    );
  }

  private async consumeEvents(): Promise<void> {
    try {
      for await (const message of this
        .activeQuery as AsyncIterable<SDKMessage>) {
        await processMessage(message as Record<string, unknown>, this.eventState, {
          onSessionId: (sessionId) => {
            this.config.resume = sessionId;
            this.config.forkSession = false;
            this.config.onSessionId?.(sessionId);
          },
          onPromptRequest: this.config.onPromptRequest,
          onProgress: (event) => this.emitProgress(event),
          onResult: async (result) => {
            if (result.sessionId) {
              this.config.resume = result.sessionId;
              this.config.forkSession = false;
            }
            // Clear activeQuery so next send() starts a new query with resume
            // SDK closes stdin after result, can't streamInput() on it anymore
            this.activeQuery = null;
            await this.emitResult(result);
          },
          sendPromptResponse: async (requestId, selected) => {
            if (!this.activeQuery) return;
            try {
              await this.activeQuery.streamInput(
                (async function* () {
                  yield {
                    prompt_response: requestId,
                    selected,
                  } as unknown as SDKUserMessage;
                })(),
              );
            } catch (error) {
              logError("SESSION", "prompt_response_stream_failed", error, {
                sessionId: this.eventState.sessionId,
                requestId,
              });
              throw error;
            }
          },
          markClosed: () => {
            this.closed = true;
          },
        });
      }
      // Query ended normally (close() was called or CLI exited cleanly)
      // Don't emit result here — close() handles cleanup
    } catch (err) {
      // Query crashed or threw an error
      logError("SESSION", "query_ended_with_error", err, {
        sessionId: this.eventState.sessionId,
      });
      const info = this.classifyError(err);
      await this.emitResult({
        error: info.message,
        errorCode: info.code,
        interrupted: true,
        tools: [...this.eventState.turnTools],
        sessionId: this.eventState.sessionId,
      });
    } finally {
      this.activeQuery = null;
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
      executable: process.argv[0],
      pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
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

  private classifyError(error: unknown): { code?: ErrorCode; message: string } {
    if (error instanceof AppError) {
      return { code: error.code, message: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { code: classifyErrorCode(message), message };
  }
}

async function preparePrompt(
  prompt: string,
  images?: ImageInput[],
): Promise<string> {
  if (!images || images.length === 0) return prompt;

  const paths = await saveImagesToTmp(images);
  logInfo("SESSION", "images_prepared", { count: paths.length });
  const imageRefs = paths.map((p) => `[Uploaded image: ${p}]`).join("\n");
  return `The user sent the following image(s). Use the Read tool to view them:\n${imageRefs}\n\n${prompt}`;
}
