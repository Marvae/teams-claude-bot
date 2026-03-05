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
      if (resultResolve) { resultResolve(r); resultResolve = null; }
    },
    ...overrides,
  };

  return {
    session: new ConversationSession(config),
    events,
    results,
    nextResult: () => new Promise<ClaudeResult>((resolve) => {
      if (results.length > 0) { resolve(results[results.length - 1]); return; }
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
  beforeEach(() => { mockQuery.mockReset(); });

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
      expect(await extractPromptText(mockQuery.mock.calls[0][0].prompt)).toBe("hello world");
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
      mockQuery.mockImplementation(async function* () { yield { type: "result", result: "OK" }; });
      const { session, nextResult } = makeSession({ cwd: "/home/user/project" });
      session.send("start");
      await nextResult();
      expect(mockQuery.mock.calls[0][0].options.cwd).toBe("/home/user/project");
    });
  });

  describe("tool progress events", () => {
    it("calls onProgress for tool_progress messages", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield { type: "tool_progress", tool: "Bash", input: { command: "npm test" } };
        yield { type: "tool_progress", tool: "Read", input: { file_path: "src/index.ts" } };
        yield { type: "result", result: "Done" };
      });
      const { session, events, nextResult } = makeSession();
      session.send("run tests");
      await nextResult();
      const toolEvents = events.filter((e) => e.type === "tool_use");
      expect(toolEvents).toHaveLength(2);
      expect(toolEvents[0]).toEqual({ type: "tool_use", tool: { name: "Bash", command: "npm test" } });
    });

    it("truncates long commands in progress", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield { type: "tool_progress", tool: "Bash", input: { command: "x".repeat(200) } };
        yield { type: "result", result: "Done" };
      });
      const { session, events, nextResult } = makeSession();
      session.send("test");
      await nextResult();
      const toolEvent = events.find((e) => e.type === "tool_use");
      expect(toolEvent?.type === "tool_use" && toolEvent.tool.command?.length).toBe(100);
    });
  });

  describe("tool collection from assistant messages", () => {
    it("extracts tools from assistant message content", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "output.txt" } }] } };
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
      mockQuery.mockImplementation(() => { throw new Error("API rate limited"); });
      const { session, nextResult } = makeSession();
      session.send("test");
      expect((await nextResult()).error).toContain("API rate limited");
    });

    it("returns error from result message", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield { type: "result", is_error: true, errors: ["Something went wrong"] };
      });
      const { session, nextResult } = makeSession();
      session.send("test");
      expect((await nextResult()).error).toBe("Something went wrong");
    });
  });

  describe("permission mode", () => {
    it("uses default permission mode by default", async () => {
      mockQuery.mockImplementation(async function* () { yield { type: "result", result: "OK" }; });
      const { session, nextResult } = makeSession();
      session.send("test");
      await nextResult();
      expect(mockQuery.mock.calls[0][0].options.permissionMode).toBe("default");
    });

    it("uses provided permissionMode", async () => {
      mockQuery.mockImplementation(async function* () { yield { type: "result", result: "OK" }; });
      const { session, nextResult } = makeSession({ permissionMode: "bypassPermissions" });
      session.send("test");
      await nextResult();
      expect(mockQuery.mock.calls[0][0].options.permissionMode).toBe("bypassPermissions");
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
        [Symbol.asyncIterator]() { return this; },
        async next() { return new Promise<IteratorResult<unknown>>((resolve) => { closeQuery = () => resolve({ value: undefined, done: true }); }); },
        async return() { return { value: undefined, done: true as const }; },
        async throw(e: unknown) { throw e; },
        interrupt: vi.fn(),
        close: vi.fn(() => { closeQuery?.(); }),
      }));
      const { session } = makeSession();
      session.send("test");
      session.close();
      expect(session.hasQuery).toBe(false);
    });
  });

  describe("prompt suggestions", () => {
    it("passes prompt suggestion through done event", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield { type: "prompt_suggestion", prompt: "Run the tests" };
        yield { type: "result", result: "Done" };
      });
      const { session, events, nextResult } = makeSession();
      session.send("fix the bug");
      await nextResult();
      expect(events.find((e) => e.type === "done")).toEqual({ type: "done", promptSuggestion: "Run the tests" });
    });

    it("done event has no suggestion when SDK does not emit one", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield { type: "result", result: "Done" };
      });
      const { session, events, nextResult } = makeSession();
      session.send("hello");
      await nextResult();
      expect(events.find((e) => e.type === "done")).toEqual({ type: "done", promptSuggestion: undefined });
    });
  });
});
