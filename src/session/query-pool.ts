/**
 * Query pool — manages persistent Query objects per conversation.
 *
 * Each conversation gets at most one long-lived CLI subprocess.
 * Messages are fed via an AsyncQueue (async generator prompt),
 * and results are routed to per-turn handlers via TurnCollector.
 */

import {
  query as createQuery,
  type CanUseTool as SDKCanUseTool,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type PromptRequestOption,
} from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "./async-queue.js";
import type {
  ToolInfo,
  ClaudeResult,
  ProgressEvent,
  PromptRequestInfo,
} from "../claude/agent.js";

// ---------------------------------------------------------------------------
// TurnCollector — accumulates stream messages for the current turn
// ---------------------------------------------------------------------------

export type TurnHandlers = {
  onProgress?: (event: ProgressEvent) => void;
  onPromptRequest?: (info: PromptRequestInfo) => Promise<string>;
};

interface TurnCollector {
  resolve: (result: ClaudeResult) => void;
  reject: (err: Error) => void;
  tools: ToolInfo[];
  resultText?: string;
  sessionId?: string;
  handlers: TurnHandlers;
}

// ---------------------------------------------------------------------------
// ManagedQuery
// ---------------------------------------------------------------------------

export interface ManagedQuery {
  query: Query;
  inputQueue: AsyncQueue<SDKUserMessage>;
  conversationId: string;
  lastActivityAt: number;
  busy: boolean;
  sessionId?: string;
  /** Currently active turn collector (set while busy) */
  currentTurn: TurnCollector | null;
  /** Background stream drainer promise */
  streamDrainer: Promise<void>;
  /** Mutable permission mode wrapper */
  permissionMode: { current: string };
  /** Mutable canUseTool wrapper — the real handler called inside */
  canUseToolHandler: {
    current: SDKCanUseTool | null;
  };
}

// ---------------------------------------------------------------------------
// Stream message routing — shared between pool drainer and sendMessage
// ---------------------------------------------------------------------------

function routeMessage(
  message: SDKMessage,
  managed: ManagedQuery,
  activeQuery: Query,
): void {
  const turn = managed.currentTurn;

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
    const sid = (message as Record<string, unknown>).session_id as string;
    managed.sessionId = sid;
    if (turn) turn.sessionId = sid;
  }

  if (!turn) return;

  // PromptRequest handling (duck-type detection)
  if (
    typeof message === "object" &&
    message !== null &&
    "prompt" in message &&
    "message" in message &&
    "options" in message
  ) {
    const req = message as {
      prompt: string;
      message: string;
      options: PromptRequestOption[];
    };
    if (turn.handlers.onPromptRequest) {
      // Fire async — response will be sent via streamInput
      turn.handlers
        .onPromptRequest({
          requestId: req.prompt,
          message: req.message,
          options: req.options,
        })
        .then(async (selected) => {
          // Send prompt response back via streamInput
          if (typeof activeQuery.streamInput === "function") {
            const response = {
              prompt_response: req.prompt,
              selected,
            };
            async function* stream(): AsyncIterable<SDKUserMessage> {
              yield response as unknown as SDKUserMessage;
            }
            await activeQuery.streamInput(stream());
          }
        })
        .catch((err) =>
          console.error("[QUERY-POOL] PromptRequest handler error:", err),
        );
    }
  }

  // tool_progress events
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    (message as Record<string, unknown>).type === "tool_progress"
  ) {
    const progress = message as Record<string, unknown>;
    const toolName =
      (progress.tool_name as string | undefined) ??
      (progress.tool as string | undefined);
    if (toolName) {
      const toolInfo: ToolInfo = { name: toolName };
      const input = progress.input as Record<string, unknown> | undefined;
      if (input) {
        if (typeof input.file_path === "string") toolInfo.file = input.file_path;
        if (typeof input.command === "string")
          toolInfo.command = input.command.slice(0, 100);
        if (typeof input.pattern === "string") toolInfo.pattern = input.pattern;
      }
      turn.handlers.onProgress?.({ type: "tool_use", tool: toolInfo });
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
          turn.tools.push(toolInfo);
          turn.handlers.onProgress?.({ type: "tool_use", tool: toolInfo });
        }
      }
    }
  }

  // Capture final result — resolves the current turn
  if (
    typeof message === "object" &&
    message !== null &&
    "result" in message
  ) {
    turn.resultText = (message as Record<string, unknown>).result as string;
    // Result message means this turn is done
    turn.resolve({
      sessionId: turn.sessionId ?? managed.sessionId,
      result: turn.resultText ?? "",
      tools: turn.tools,
    });
    managed.currentTurn = null;
    managed.busy = false;
    managed.lastActivityAt = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Create a persistent query with async-generator prompt
// ---------------------------------------------------------------------------

export interface CreateQueryOptions {
  workDir?: string;
  model?: string;
  thinkingTokens?: number | null;
  permissionMode?: string;
  canUseTool?: SDKCanUseTool;
  sessionId?: string;
  /** Internal: skip continue on retry after crash */
  _skipContinue?: boolean;
}

function createPersistentQuery(
  managed: ManagedQuery,
  opts: CreateQueryOptions,
): void {
  const inputQueue = new AsyncQueue<SDKUserMessage>();

  async function* inputGenerator(): AsyncGenerator<SDKUserMessage> {
    for await (const msg of inputQueue) {
      yield msg;
    }
  }

  const options: Record<string, unknown> = {
    allowedTools: [
      "Read",
      "Write",
      "Edit",
      "Bash",
      "Glob",
      "Grep",
      "AskUserQuestion",
    ],
    permissionMode: opts.permissionMode ?? "default",
    allowDangerouslySkipPermissions:
      opts.permissionMode === "bypassPermissions",
    maxTurns: 50,
    executable: process.execPath,
  };

  if (opts.model) options.model = opts.model;
  if (opts.thinkingTokens !== undefined && opts.thinkingTokens !== null) {
    options.maxThinkingTokens = opts.thinkingTokens;
  }
  if (opts.workDir) {
    options.cwd = opts.workDir;
  }
  // In streaming mode, use `continue` to resume the most recent session
  // in the working directory. If no previous session exists, CLI starts a new one.
  // (resume + async generator causes CLI crash, so we use continue instead.)
  if (!opts._skipContinue) {
    options.continue = true;
  }

  // Mutable canUseTool wrapper
  const canUseToolWrapper: SDKCanUseTool = async (toolName, input, callOpts) => {
    const handler = managed.canUseToolHandler.current;
    if (!handler) {
      // No handler → bypass mode, allow everything
      return {
        behavior: "allow" as const,
        updatedInput: input,
        toolUseID: callOpts.toolUseID,
      };
    }
    return handler(toolName, input, callOpts);
  };
  options.canUseTool = canUseToolWrapper;

  console.log(
    `[QUERY-POOL] createPersistentQuery: cwd=${(options.cwd as string) ?? "none"}, continue=${!!options.continue}`,
  );

  const q = createQuery({ prompt: inputGenerator(), options });

  managed.query = q;
  managed.inputQueue = inputQueue;

  // Start background stream drainer
  managed.streamDrainer = (async () => {
    try {
      for await (const message of q as AsyncIterable<SDKMessage>) {
        routeMessage(message, managed, q);
      }
    } catch (err) {
      console.error("[QUERY-POOL] Stream error:", err);
      // If the query crashed and we haven't received any session init,
      // retry without continue (fresh session).
      if (options.continue && !managed.sessionId) {
        console.warn("[QUERY-POOL] continue failed, retrying with fresh session");
        const retryOpts = { ...opts, sessionId: undefined };
        retryOpts._skipContinue = true;
        createPersistentQuery(managed, retryOpts);
        return;
      }
      // If a turn is active, reject it
      if (managed.currentTurn) {
        managed.currentTurn.reject(
          err instanceof Error ? err : new Error(String(err)),
        );
        managed.currentTurn = null;
        managed.busy = false;
      }
    } finally {
      console.log(
        `[QUERY-POOL] Stream ended for ${managed.conversationId.slice(0, 12)}`,
      );
    }
  })();
}

// ---------------------------------------------------------------------------
// QueryPool
// ---------------------------------------------------------------------------

const IDLE_SWEEP_INTERVAL_MS = 60_000;
const IDLE_TIMEOUT_MS = 30 * 60_000;
const TURN_TIMEOUT_MS = 10 * 60_000; // 10 minutes per turn

class QueryPool {
  private pool = new Map<string, ManagedQuery>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.startSweep();
  }

  get size(): number {
    return this.pool.size;
  }

  /**
   * Get or create a ManagedQuery for the given conversation.
   * If options change (workDir, model), the existing query is reused
   * (caller can use query.setModel() etc. for hot updates).
   */
  acquire(
    conversationId: string,
    opts: CreateQueryOptions,
  ): ManagedQuery {
    let managed = this.pool.get(conversationId);
    if (managed) {
      managed.lastActivityAt = Date.now();
      return managed;
    }

    // Create new managed query
    managed = {
      query: null!,
      inputQueue: null!,
      conversationId,
      lastActivityAt: Date.now(),
      busy: false,
      sessionId: opts.sessionId,
      currentTurn: null,
      streamDrainer: null!,
      permissionMode: { current: opts.permissionMode ?? "default" },
      canUseToolHandler: { current: opts.canUseTool ?? null },
    };

    createPersistentQuery(managed, opts);
    this.pool.set(conversationId, managed);
    console.log(
      `[QUERY-POOL] Created query for ${conversationId.slice(0, 12)} (pool size: ${this.pool.size})`,
    );
    return managed;
  }

  /**
   * Send a message to a managed query and wait for the result.
   */
  async sendMessage(
    managed: ManagedQuery,
    text: string,
    handlers: TurnHandlers,
  ): Promise<ClaudeResult> {
    // Guard: reject any existing in-flight turn to prevent orphaned promises
    if (managed.busy && managed.currentTurn) {
      managed.currentTurn.reject(new Error("Superseded by new turn"));
      managed.currentTurn = null;
    }

    managed.busy = true;
    managed.lastActivityAt = Date.now();

    // Create a turn collector that will accumulate results (with timeout)
    const resultPromise = new Promise<ClaudeResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        managed.currentTurn = null;
        managed.busy = false;
        reject(new Error("Turn timed out"));
      }, TURN_TIMEOUT_MS);

      managed.currentTurn = {
        resolve: (result) => { clearTimeout(timeout); resolve(result); },
        reject: (err) => { clearTimeout(timeout); reject(err); },
        tools: [],
        handlers,
      };
    });

    // Push user message through the input queue
    const userMessage: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: managed.sessionId ?? "",
    };
    managed.inputQueue.push(userMessage);

    try {
      return await resultPromise;
    } catch (err) {
      managed.busy = false;
      managed.lastActivityAt = Date.now();
      throw err;
    }
  }

  /**
   * Remove and close a query for a conversation.
   */
  async remove(conversationId: string): Promise<void> {
    const managed = this.pool.get(conversationId);
    if (!managed) return;

    this.pool.delete(conversationId);
    console.log(
      `[QUERY-POOL] Removing query for ${conversationId.slice(0, 12)} (pool size: ${this.pool.size})`,
    );

    try {
      managed.inputQueue.end();
      managed.query.close();
      // If a turn is active, reject it
      if (managed.currentTurn) {
        managed.currentTurn.reject(new Error("Query closed"));
        managed.currentTurn = null;
        managed.busy = false;
      }
    } catch {
      // Ignore close errors
    }
  }

  /**
   * Close all queries — used for graceful shutdown.
   */
  async closeAll(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }

    const ids = [...this.pool.keys()];
    await Promise.allSettled(ids.map((id) => this.remove(id)));
  }

  /**
   * Check if a conversation has an active query.
   */
  has(conversationId: string): boolean {
    return this.pool.has(conversationId);
  }

  /**
   * Get a managed query without creating one.
   */
  get(conversationId: string): ManagedQuery | undefined {
    return this.pool.get(conversationId);
  }

  private startSweep(): void {
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, managed] of this.pool) {
        if (!managed.busy && now - managed.lastActivityAt > IDLE_TIMEOUT_MS) {
          console.log(
            `[QUERY-POOL] Idle sweep: closing ${id.slice(0, 12)}`,
          );
          void this.remove(id);
        }
      }
    }, IDLE_SWEEP_INTERVAL_MS);

    // Don't prevent process exit
    this.sweepTimer.unref();
  }
}

// Singleton
export const queryPool = new QueryPool();
