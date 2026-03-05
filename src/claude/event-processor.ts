import type { PromptRequestOption } from "@anthropic-ai/claude-agent-sdk";
import { extractToolInfo, classifyErrorCode } from "./types.js";
import type {
  ClaudeResult,
  ProgressEvent,
  PromptRequestInfo,
  ToolInfo,
} from "./types.js";
import { ERROR_CODES, type ErrorCode } from "../errors/error-codes.js";
import { logError, logInfo, sanitizeCommandName } from "../logging/logger.js";

export interface EventProcessorState {
  sessionId?: string;
  lastPromptSuggestion?: string;
  turnTools: ToolInfo[];
  turnStreamingText: string;
}

export interface EventProcessorContext {
  onSessionId?: (sessionId: string) => void;
  onPromptRequest?: (info: PromptRequestInfo) => Promise<string>;
  onProgress: (event: ProgressEvent) => void;
  onResult: (result: ClaudeResult) => Promise<void>;
  sendPromptResponse: (requestId: string, selected: string) => Promise<void>;
  markClosed: () => void;
}

export async function processMessage(
  msg: Record<string, unknown>,
  state: EventProcessorState,
  context: EventProcessorContext,
): Promise<void> {
  // ── Init message ──
  if (
    msg.type === "system" &&
    msg.subtype === "init" &&
    typeof msg.session_id === "string"
  ) {
    state.sessionId = msg.session_id;
    logInfo("SESSION", "initialized", { sessionId: state.sessionId });
    context.onSessionId?.(state.sessionId);
  }

  // ── Auth status ──
  if (msg.type === "auth_status") {
    const error = msg.error as string | undefined;
    if (error) {
      logError("SESSION", "auth_error", new Error(error), {
        sessionId: state.sessionId,
      });
      context.onProgress({ type: "auth_error", error });
    }
  }

  // ── PromptRequest ──
  if ("prompt" in msg && "message" in msg && "options" in msg) {
    await handlePromptRequest(msg, state, context);
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
      logInfo("TOOL", "used", {
        sessionId: state.sessionId,
        toolName: toolInfo.name,
        filePath: toolInfo.file,
        command: sanitizeCommandName(toolInfo.command),
      });
      context.onProgress({ type: "tool_use", tool: toolInfo });
    }
  }

  // ── Streaming text ──
  if (msg.type === "stream_event" && msg.parent_tool_use_id === null) {
    const evt = msg.event as Record<string, unknown> | undefined;
    if (evt?.type === "content_block_delta") {
      const delta = evt.delta as Record<string, unknown> | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        state.turnStreamingText += delta.text;
        context.onProgress({
          type: "text",
          text: state.turnStreamingText,
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
      context.onProgress({
        type: "rate_limit",
        status: info.status,
        resetsAt: info.resetsAt as number | undefined,
      });
    }
  }

  // ── Tool use summary ──
  if (msg.type === "tool_use_summary" && typeof msg.summary === "string") {
    context.onProgress({
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
        context.onProgress({
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
      context.onProgress({
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
    const summary = (msg.summary as string) ?? (msg.description as string) ?? "";
    context.onProgress({
      type: "task_status",
      taskId: msg.task_id,
      status,
      summary,
    });
  }

  // ── Assistant message (collect tools, extract todos, reset streaming) ──
  if (msg.type === "assistant") {
    state.turnStreamingText = "";
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
            const todos = input?.todos as Array<Record<string, unknown>> | undefined;
            if (Array.isArray(todos)) {
              context.onProgress({
                type: "todo",
                todos: todos.map((t) => ({
                  content: (t.content as string) ?? (t.subject as string) ?? "",
                  status:
                    (t.status as "pending" | "in_progress" | "completed") ??
                    "pending",
                  activeForm: t.activeForm as string | undefined,
                })),
              });
            }
          }
          state.turnTools.push(
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
    state.lastPromptSuggestion = msg.prompt;
  }

  // ── Result ──
  if (msg.type === "result") {
    context.onProgress({
      type: "done",
      promptSuggestion: state.lastPromptSuggestion,
    });
    state.lastPromptSuggestion = undefined;

    const stopReason = (msg.stop_reason as string | null) ?? null;
    const subtype = typeof msg.subtype === "string" ? msg.subtype : undefined;
    const isError = msg.is_error === true;

    // Interrupt result — error_during_execution with is_error: false means interrupt
    if (
      subtype === "interrupt" ||
      (subtype === "error_during_execution" && !isError) ||
      (msg as Record<string, unknown>).is_interrupt === true
    ) {
      const partialText =
        (msg.result as string) || state.turnStreamingText || undefined;
      await context.onResult({
        sessionId: state.sessionId,
        result: partialText,
        interrupted: true,
        tools: [...state.turnTools],
        stopReason,
      });
      return;
    }

    const hasError =
      isError ||
      (typeof subtype === "string" && subtype.startsWith("error_"));

    if (hasError) {
      context.markClosed();
      const errors = msg.errors as string[] | undefined;
      const errorMsg =
        errors && errors.length > 0
          ? errors.join("; ")
          : `Error: ${subtype ?? "unknown"}`;
      const errorCode = classifyResultErrorCode(subtype, errorMsg);
      logError("SESSION", "result_error", new Error(errorMsg), {
        sessionId: state.sessionId,
        stopReason,
        errorCode,
      });
      await context.onResult({
        error: errorMsg,
        errorCode,
        sessionId: state.sessionId,
        tools: [...state.turnTools],
        stopReason,
      });
      return;
    }

    const usage = msg.usage as
      | { input_tokens: number; output_tokens: number }
      | undefined;
    logInfo("SESSION", "result_received", {
      sessionId: state.sessionId,
      stopReason,
    });
    await context.onResult({
      sessionId: state.sessionId,
      result: (msg.result as string) ?? "",
      tools: [...state.turnTools],
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
    await context.onResult({
      sessionId: state.sessionId,
      result: msg.result as string,
      tools: [...state.turnTools],
    });
  }
}

async function handlePromptRequest(
  msg: Record<string, unknown>,
  state: EventProcessorState,
  context: EventProcessorContext,
): Promise<void> {
  if (!context.onPromptRequest) return;

  const req = msg as {
    prompt: string;
    message: string;
    options: PromptRequestOption[];
  };

  logInfo("SESSION", "prompt_request_received", {
    sessionId: state.sessionId,
    requestId: req.prompt,
    optionsCount: req.options?.length,
  });

  const selected = await context.onPromptRequest({
    requestId: req.prompt,
    message: req.message,
    options: req.options,
  });

  try {
    await context.sendPromptResponse(req.prompt, selected);
    logInfo("SESSION", "prompt_response_streamed", {
      sessionId: state.sessionId,
      requestId: req.prompt,
    });
  } catch (error) {
    logError("SESSION", "prompt_response_stream_failed", error, {
      sessionId: state.sessionId,
      requestId: req.prompt,
    });
    throw error;
  }
}

function classifyResultErrorCode(
  subtype: string | undefined,
  errorMsg: string,
): ErrorCode | undefined {
  if (subtype === "error_session") {
    return ERROR_CODES.CLAUDE_SESSION_NOT_FOUND;
  }
  return classifyErrorCode(errorMsg);
}
