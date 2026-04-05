/**
 * ConversationSession tests — mock SDK to test streaming session logic.
 * Tests: session lifecycle, progress events, error handling, interrupt, prompt requests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClaudeResult, ProgressEvent } from "../src/claude/agent.js";

// Mock the SDK
const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => mockQuery(args),
  getSessionMessages: vi.fn().mockResolvedValue([]),
}));

import {
  ConversationSession,
  type SessionConfig,
} from "../src/claude/session.js";

function makeSession(overrides: Partial<SessionConfig> = {}): {
  session: ConversationSession;
  events: ProgressEvent[];
  results: ClaudeResult[];
  nextResult: () => Promise<ClaudeResult>;
} {
  const events: ProgressEvent[] = [];
  const results: ClaudeResult[] = [];
  let resultResolve: ((r: ClaudeResult) => void) | null = null;

  const config: SessionConfig = {
    cwd: "/work/test",
    permissionMode: "default",
    onProgress: (e) => events.push(e),
    onResult: (r) => {
      results.push(r);
      if (resultResolve) {
        resultResolve(r);
        resultResolve = null;
      }
    },
    ...overrides,
  };

  return {
    session: new ConversationSession(config),
    events,
    results,
    nextResult: () =>
      new Promise<ClaudeResult>((resolve) => {
        if (results.length > 0) {
          resolve(results[results.length - 1]);
          return;
        }
        resultResolve = resolve;
      }),
  };
}

async function extractPromptText(
  prompt: AsyncGenerator<{ message: { content: string } }>,
): Promise<string> {
  const first = await prompt.next();
  return first.value.message.content;
}

describe("ConversationSession", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe("basic execution", () => {
    it("sends first message and captures session ID", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-123" };
        yield { type: "result", result: "Done!" };
      });
      const onSessionId = vi.fn();
      const { session, nextResult } = makeSession({ onSessionId });
      session.send("hello world");
      const result = await nextResult();
      expect(mockQuery).toHaveBeenCalledOnce();
      expect(await extractPromptText(mockQuery.mock.calls[0][0].prompt)).toBe(
        "hello world",
      );
      expect(result.result).toBe("Done!");
      expect(onSessionId).toHaveBeenCalledWith("sess-123");
    });

    it("returns result text from result message", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield { type: "result", result: "Here is my response" };
      });
      const { session, nextResult } = makeSession();
      session.send("test");
      expect((await nextResult()).result).toBe("Here is my response");
    });

    it("passes cwd to SDK options", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "result", result: "OK" };
      });
      const { session, nextResult } = makeSession({
        cwd: "/home/user/project",
      });
      session.send("start");
      await nextResult();
      expect(mockQuery.mock.calls[0][0].options.cwd).toBe("/home/user/project");
    });
  });

  describe("tool progress events", () => {
    it("calls onProgress for tool_progress messages", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield {
          type: "tool_progress",
          tool: "Bash",
          input: { command: "npm test" },
        };
        yield {
          type: "tool_progress",
          tool: "Read",
          input: { file_path: "src/index.ts" },
        };
        yield { type: "result", result: "Done" };
      });
      const { session, events, nextResult } = makeSession();
      session.send("run tests");
      await nextResult();
      const toolEvents = events.filter((e) => e.type === "tool_use");
      expect(toolEvents).toHaveLength(2);
      expect(toolEvents[0]).toEqual({
        type: "tool_use",
        tool: { name: "Bash", command: "npm test" },
      });
    });

    it("truncates long commands in progress", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield {
          type: "tool_progress",
          tool: "Bash",
          input: { command: "x".repeat(200) },
        };
        yield { type: "result", result: "Done" };
      });
      const { session, events, nextResult } = makeSession();
      session.send("test");
      await nextResult();
      const toolEvent = events.find((e) => e.type === "tool_use");
      expect(
        toolEvent?.type === "tool_use" && toolEvent.tool.command?.length,
      ).toBe(100);
    });
  });

  describe("tool collection from assistant messages", () => {
    it("extracts tools from assistant message content", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield {
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
        };
        yield { type: "result", result: "Done" };
      });
      const { session, nextResult } = makeSession();
      session.send("write something");
      const result = await nextResult();
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0]).toEqual({ name: "Write", file: "output.txt" });
    });
  });

  describe("error handling", () => {
    it("returns error when SDK throws during query creation", async () => {
      mockQuery.mockImplementation(() => {
        throw new Error("API rate limited");
      });
      const { session, nextResult } = makeSession();
      session.send("test");
      expect((await nextResult()).error).toContain("API rate limited");
    });

    it("returns error from result message", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield {
          type: "result",
          is_error: true,
          errors: ["Something went wrong"],
        };
      });
      const { session, nextResult } = makeSession();
      session.send("test");
      expect((await nextResult()).error).toBe("Something went wrong");
    });

    it("session stays alive after error result — can process next message", async () => {
      const pending: Array<(msg: IteratorResult<unknown>) => void> = [];
      mockQuery.mockImplementation(() => ({
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          return new Promise<IteratorResult<unknown>>((resolve) => {
            pending.push(resolve);
          });
        },
        async return() {
          return { value: undefined, done: true as const };
        },
        async throw(e: unknown) {
          throw e;
        },
      }));

      const yieldMsg = async (msg: unknown) => {
        await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
        pending.shift()!({ value: msg, done: false });
        await new Promise((r) => setTimeout(r, 10));
      };
      const finish = async () => {
        await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
        pending.shift()!({ value: undefined, done: true });
        await new Promise((r) => setTimeout(r, 10));
      };

      const { session, results } = makeSession();

      session.send("do something risky");
      await yieldMsg({ type: "system", subtype: "init", session_id: "s1" });

      // SDK returns error_during_execution — this is per-turn, query is still alive
      await yieldMsg({
        type: "result",
        is_error: true,
        subtype: "error_during_execution",
        errors: ["User rejected tool use"],
      });

      expect(results).toHaveLength(1);
      expect(results[0].error).toBe("User rejected tool use");
      expect(session.hasQuery).toBe(true);

      // User can send follow-up — query still accepts messages
      session.send("what branch am I on?");
      await yieldMsg({ type: "result", result: "You are on main branch." });

      // Result is pending until iterator ends (pendingResult waits for prompt_suggestion)
      await finish();

      expect(results).toHaveLength(2);
      expect(results[1].result).toBe("You are on main branch.");
      expect(results[1].error).toBeUndefined();
    });

    it("auto-starts new query after previous query exits", async () => {
      let callCount = 0;
      mockQuery.mockImplementation(async function* () {
        callCount++;
        yield { type: "system", subtype: "init", session_id: `s${callCount}` };
        yield { type: "result", result: `response ${callCount}` };
      });

      const { session, results, nextResult } = makeSession();

      session.send("first");
      await nextResult();
      await new Promise((r) => setTimeout(r, 10)); // let consumeEvents finish

      // Query exited — next send should auto-start a new one
      session.send("second");
      await vi.waitFor(() => expect(results).toHaveLength(2));
      expect(results[1].result).toBe("response 2");
      expect(callCount).toBe(2);
    });
  });

  describe("permission mode", () => {
    it("uses default permission mode by default", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "result", result: "OK" };
      });
      const { session, nextResult } = makeSession();
      session.send("test");
      await nextResult();
      expect(mockQuery.mock.calls[0][0].options.permissionMode).toBe("default");
    });

    it("uses provided permissionMode", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "result", result: "OK" };
      });
      const { session, nextResult } = makeSession({
        permissionMode: "bypassPermissions",
      });
      session.send("test");
      await nextResult();
      expect(mockQuery.mock.calls[0][0].options.permissionMode).toBe(
        "bypassPermissions",
      );
    });
  });

  describe("stop_reason", () => {
    it("returns stopReason from result message", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield { type: "result", result: "Done", stop_reason: "end_turn" };
      });
      const { session, nextResult } = makeSession();
      session.send("test");
      expect((await nextResult()).stopReason).toBe("end_turn");
    });

    it("returns null stopReason when not present", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield { type: "result", result: "OK" };
      });
      const { session, nextResult } = makeSession();
      session.send("test");
      expect((await nextResult()).stopReason).toBeNull();
    });
  });

  describe("close", () => {
    it("cleans up resources on close", async () => {
      let closeQuery: (() => void) | undefined;
      mockQuery.mockImplementation(() => ({
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          return new Promise<IteratorResult<unknown>>((resolve) => {
            closeQuery = () => resolve({ value: undefined, done: true });
          });
        },
        async return() {
          return { value: undefined, done: true as const };
        },
        async throw(e: unknown) {
          throw e;
        },
        interrupt: vi.fn(),
        close: vi.fn(() => {
          closeQuery?.();
        }),
      }));
      const { session } = makeSession();
      session.send("test");
      session.close();
      expect(session.hasQuery).toBe(false);
    });
  });

  describe("streaming text accumulation", () => {
    it("does not reset streaming text when sending to existing query", async () => {
      // Use a controllable async iterator to yield messages on demand
      const pending: Array<(msg: IteratorResult<unknown>) => void> = [];
      mockQuery.mockImplementation(() => ({
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          return new Promise<IteratorResult<unknown>>((resolve) => {
            pending.push(resolve);
          });
        },
        async return() {
          return { value: undefined, done: true as const };
        },
        async throw(e: unknown) {
          throw e;
        },
      }));

      const yieldMsg = async (msg: unknown) => {
        await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
        pending.shift()!({ value: msg, done: false });
        await new Promise((r) => setTimeout(r, 10));
      };
      const finish = async () => {
        await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
        pending.shift()!({ value: undefined, done: true });
      };

      const { session, events } = makeSession();

      // Start query
      session.send("hello");
      await yieldMsg({ type: "system", subtype: "init", session_id: "s1" });

      // Yield some streaming text
      await yieldMsg({
        type: "stream_event",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hello " },
        },
      });
      await yieldMsg({
        type: "stream_event",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "world" },
        },
      });

      // Verify delta text events
      const textEvents = events.filter((e) => e.type === "text");
      expect(textEvents).toHaveLength(2);
      expect(textEvents[1]).toEqual({ type: "text", text: "world" });

      // User sends another message mid-stream — should NOT reset streaming text
      session.send("follow up");

      // Yield more streaming text — should continue accumulating
      await yieldMsg({
        type: "stream_event",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "!" },
        },
      });

      const allTextEvents = events.filter((e) => e.type === "text");
      const last = allTextEvents[allTextEvents.length - 1];
      expect(last).toEqual({ type: "text", text: "!" });

      // Clean up
      await finish();
    });
  });

  describe("prompt suggestions", () => {
    it("emits prompt_suggestion as a separate progress event", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield { type: "result", result: "Done" };
        yield { type: "prompt_suggestion", suggestion: "Run the tests" };
      });
      const { session, events, nextResult } = makeSession();
      session.send("fix the bug");
      await nextResult();
      // prompt_suggestion is processed after result — wait for event loop
      await new Promise((r) => setTimeout(r, 10));
      const suggestionEvents = events.filter(
        (e) => e.type === "prompt_suggestion",
      );
      expect(suggestionEvents).toHaveLength(1);
      expect(
        (suggestionEvents[0] as { suggestion: string }).suggestion,
      ).toBe("Run the tests");
    });

    it("no prompt_suggestion event when SDK does not emit one", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield { type: "result", result: "Done" };
      });
      const { session, events, nextResult } = makeSession();
      session.send("hello");
      await nextResult();
      const suggestionEvents = events.filter(
        (e) => e.type === "prompt_suggestion",
      );
      expect(suggestionEvents).toHaveLength(0);
    });
  });
});
