import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  processMessage,
  type EventProcessorContext,
  type EventProcessorState,
} from "../../src/claude/event-processor.js";
import { ERROR_CODES } from "../../src/errors/error-codes.js";
import type { ClaudeResult, ProgressEvent } from "../../src/claude/types.js";

function makeHarness(overrides: Partial<EventProcessorContext> = {}) {
  const events: ProgressEvent[] = [];
  const results: ClaudeResult[] = [];
  let closed = false;

  const state: EventProcessorState = {
    turnTools: [],
    turnStreamingText: "",
  };

  const context: EventProcessorContext = {
    onSessionId: vi.fn((sessionId: string) => {
      state.sessionId = sessionId;
    }),
    onPromptRequest: vi.fn(),
    onProgress: (event) => events.push(event),
    onResult: async (result) => {
      results.push(result);
    },
    sendPromptResponse: vi.fn().mockResolvedValue(undefined),
    markClosed: () => {
      closed = true;
    },
    ...overrides,
  };

  return { state, context, events, results, isClosed: () => closed };
}

describe("processMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures session init and calls onSessionId", async () => {
    const { state, context } = makeHarness();

    await processMessage(
      { type: "system", subtype: "init", session_id: "sess-123" },
      state,
      context,
    );

    expect(state.sessionId).toBe("sess-123");
    expect(context.onSessionId).toHaveBeenCalledWith("sess-123");
  });

  it("emits tool_use progress for tool_progress messages", async () => {
    const { state, context, events } = makeHarness();

    await processMessage(
      {
        type: "tool_progress",
        tool: "Bash",
        input: { command: "npm test" },
      },
      state,
      context,
    );

    expect(events).toEqual([
      { type: "tool_use", tool: { name: "Bash", command: "npm test" } },
    ]);
  });

  it("emits cumulative text during stream_event deltas", async () => {
    const { state, context, events } = makeHarness();

    await processMessage(
      {
        type: "stream_event",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hello" },
        },
      },
      state,
      context,
    );
    await processMessage(
      {
        type: "stream_event",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: " world" },
        },
      },
      state,
      context,
    );

    expect(events).toContainEqual({ type: "text", text: "Hello" });
    expect(events).toContainEqual({ type: "text", text: "Hello world" });
  });

  it("collects assistant tool_use blocks into state.turnTools", async () => {
    const { state, context } = makeHarness();

    await processMessage(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Write",
              input: { file_path: "output.txt" },
            },
          ],
        },
      },
      state,
      context,
    );

    expect(state.turnTools).toEqual([{ name: "Write", file: "output.txt" }]);
  });

  it("handles prompt suggestion and includes it in done event", async () => {
    const { state, context, events, results } = makeHarness();

    await processMessage(
      { type: "prompt_suggestion", prompt: "Run tests" },
      state,
      context,
    );
    await processMessage({ type: "result", result: "Done" }, state, context);

    expect(events.find((e) => e.type === "done")).toEqual({
      type: "done",
      promptSuggestion: "Run tests",
    });
    expect(results[0]?.result).toBe("Done");
  });

  it("marks closed and returns error result when result is error", async () => {
    const { state, context, results, isClosed } = makeHarness();

    await processMessage(
      {
        type: "result",
        is_error: true,
        errors: ["Something went wrong"],
      },
      state,
      context,
    );

    expect(isClosed()).toBe(true);
    expect(results[0]).toMatchObject({
      error: "Something went wrong",
      stopReason: null,
    });
  });

  it("maps SDK error_session subtype to structured errorCode", async () => {
    const { state, context, results } = makeHarness();

    await processMessage(
      {
        type: "result",
        is_error: true,
        subtype: "error_session",
        errors: ["No conversation found with session ID: stale-session"],
      },
      state,
      context,
    );

    expect(results[0]).toMatchObject({
      errorCode: ERROR_CODES.CLAUDE_SESSION_NOT_FOUND,
    });
  });

  it("maps spaced rate limit errors to structured errorCode", async () => {
    const { state, context, results } = makeHarness();

    await processMessage(
      {
        type: "result",
        is_error: true,
        errors: ["API rate limit reached"],
      },
      state,
      context,
    );

    expect(results[0]).toMatchObject({
      errorCode: ERROR_CODES.CLAUDE_RATE_LIMITED,
    });
  });

  it("handles interrupt result with partial text", async () => {
    const { state, context, results } = makeHarness();
    state.turnStreamingText = "partial";

    await processMessage(
      {
        type: "result",
        subtype: "interrupt",
      },
      state,
      context,
    );

    expect(results[0]).toMatchObject({
      interrupted: true,
      result: "partial",
      stopReason: null,
    });
  });
});
