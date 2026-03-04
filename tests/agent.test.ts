/**
 * ConversationSession tests — mock SDK to test streaming session logic.
 * Tests: session lifecycle, progress events, error handling, interrupt, prompt requests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the SDK
const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => mockQuery(args),
  getSessionMessages: vi.fn().mockResolvedValue([]),
}));

// Import after mock
import {
  ConversationSession,
  type SessionConfig,
} from "../src/claude/session.js";
import type { ProgressEvent } from "../src/claude/agent.js";

function makeConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    cwd: "/work/test",
    permissionMode: "default",
    ...overrides,
  };
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
      const session = new ConversationSession(makeConfig({ onSessionId }));

      const result = await session.send("hello world");

      expect(mockQuery).toHaveBeenCalledOnce();
      const call = mockQuery.mock.calls[0][0];
      expect(call.prompt).toBe("hello world");
      expect(result.result).toBe("Done!");
      expect(onSessionId).toHaveBeenCalledWith("sess-123");
    });

    it("returns result text from result message", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield { type: "result", result: "Here is my response" };
      });

      const session = new ConversationSession(makeConfig());
      const result = await session.send("test");

      expect(result.result).toBe("Here is my response");
    });

    it("passes cwd to SDK options", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield { type: "result", result: "OK" };
      });

      const session = new ConversationSession(
        makeConfig({ cwd: "/home/user/project" }),
      );
      await session.send("start");

      const call = mockQuery.mock.calls[0][0];
      expect(call.options.cwd).toBe("/home/user/project");
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

      const events: ProgressEvent[] = [];
      const session = new ConversationSession(makeConfig());
      await session.send("run tests", {
        onProgress: (e) => events.push(e),
      });

      // Filter out "done" event
      const toolEvents = events.filter((e) => e.type === "tool_use");
      expect(toolEvents).toHaveLength(2);
      expect(toolEvents[0]).toEqual({
        type: "tool_use",
        tool: { name: "Bash", command: "npm test" },
      });
      expect(toolEvents[1]).toEqual({
        type: "tool_use",
        tool: { name: "Read", file: "src/index.ts" },
      });
    });

    it("truncates long commands in progress", async () => {
      const longCommand = "x".repeat(200);
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield {
          type: "tool_progress",
          tool: "Bash",
          input: { command: longCommand },
        };
        yield { type: "result", result: "Done" };
      });

      const events: ProgressEvent[] = [];
      const session = new ConversationSession(makeConfig());
      await session.send("test", {
        onProgress: (e) => events.push(e),
      });

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
              {
                type: "text",
                text: "I wrote a file",
              },
            ],
          },
        };
        yield { type: "result", result: "Done" };
      });

      const session = new ConversationSession(makeConfig());
      const result = await session.send("write something");

      expect(result.tools).toHaveLength(1);
      expect(result.tools[0]).toEqual({
        name: "Write",
        file: "output.txt",
      });
    });
  });

  describe("error handling", () => {
    it("returns error when SDK throws during query creation", async () => {
      mockQuery.mockImplementation(() => {
        throw new Error("API rate limited");
      });

      const session = new ConversationSession(makeConfig());
      const result = await session.send("test");

      expect(result.error).toContain("API rate limited");
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

      const session = new ConversationSession(makeConfig());
      const result = await session.send("test");

      expect(result.error).toBe("Something went wrong");
    });
  });

  describe("permission mode", () => {
    it("uses default permission mode by default", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "result", result: "OK" };
      });

      const session = new ConversationSession(makeConfig());
      await session.send("test");

      const call = mockQuery.mock.calls[0][0];
      expect(call.options.permissionMode).toBe("default");
    });

    it("uses provided permissionMode", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "result", result: "OK" };
      });

      const session = new ConversationSession(
        makeConfig({ permissionMode: "bypassPermissions" }),
      );
      await session.send("test");

      const call = mockQuery.mock.calls[0][0];
      expect(call.options.permissionMode).toBe("bypassPermissions");
    });
  });

  describe("model and thinking tokens", () => {
    it("passes model to options", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "result", result: "OK" };
      });

      const session = new ConversationSession(
        makeConfig({ model: "claude-3-opus" }),
      );
      await session.send("test");

      const call = mockQuery.mock.calls[0][0];
      expect(call.options.model).toBe("claude-3-opus");
    });

    it("passes maxThinkingTokens when provided", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "result", result: "OK" };
      });

      const session = new ConversationSession(
        makeConfig({ thinkingTokens: 8000 }),
      );
      await session.send("test");

      const call = mockQuery.mock.calls[0][0];
      expect(call.options.maxThinkingTokens).toBe(8000);
    });

    it("skips maxThinkingTokens when null", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "result", result: "OK" };
      });

      const session = new ConversationSession(
        makeConfig({ thinkingTokens: null }),
      );
      await session.send("test");

      const call = mockQuery.mock.calls[0][0];
      expect(call.options.maxThinkingTokens).toBeUndefined();
    });
  });

  describe("canUseTool callback", () => {
    it("passes canUseTool to SDK options", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "test-session" };
        yield { type: "result", result: "Done" };
      });

      const canUseTool = vi.fn().mockResolvedValue({ behavior: "allow" });
      const session = new ConversationSession(makeConfig({ canUseTool }));
      await session.send("test prompt");

      const call = mockQuery.mock.calls[0][0];
      expect(call.options.canUseTool).toBe(canUseTool);
    });

    it("does not pass canUseTool when not provided", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "test-session" };
        yield { type: "result", result: "Done" };
      });

      const session = new ConversationSession(makeConfig());
      await session.send("test prompt");

      const call = mockQuery.mock.calls[0][0];
      expect(call.options.canUseTool).toBeUndefined();
    });
  });

  describe("PromptRequest handling", () => {
    it("calls onPromptRequest when SDK emits prompt request", async () => {
      const onPromptRequest = vi.fn().mockResolvedValue("yes");

      mockQuery.mockImplementation(() => {
        const messages = [
          { type: "system", subtype: "init", session_id: "sess-prompt" },
          {
            prompt: "confirm-123",
            message: "Do you want to continue?",
            options: [
              { key: "yes", label: "Yes" },
              { key: "no", label: "No" },
            ],
          },
          { type: "result", result: "Continued!" },
        ];
        return {
          [Symbol.asyncIterator]() {
            return this;
          },
          async next() {
            if (messages.length > 0) {
              return { value: messages.shift()!, done: false };
            }
            return { value: undefined, done: true };
          },
          async return() {
            return { value: undefined, done: true as const };
          },
          async throw(e: unknown) {
            throw e;
          },
          streamInput: vi.fn().mockResolvedValue(undefined),
          interrupt: vi.fn().mockResolvedValue(undefined),
          close: vi.fn(),
        };
      });

      const session = new ConversationSession(makeConfig({ onPromptRequest }));
      const result = await session.send("do something");

      expect(onPromptRequest).toHaveBeenCalledOnce();
      expect(onPromptRequest).toHaveBeenCalledWith({
        requestId: "confirm-123",
        message: "Do you want to continue?",
        options: [
          { key: "yes", label: "Yes" },
          { key: "no", label: "No" },
        ],
      });
      expect(result.result).toBe("Continued!");
    });

    it("skips prompt request if no callback provided", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-no-cb" };
        yield {
          prompt: "confirm-456",
          message: "Continue?",
          options: [{ key: "ok", label: "OK" }],
        };
        yield { type: "result", result: "Done anyway" };
      });

      const session = new ConversationSession(makeConfig());
      const result = await session.send("test");

      expect(result.result).toBe("Done anyway");
    });
  });

  describe("isBusy state", () => {
    it("is busy during send, idle after result", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield { type: "result", result: "OK" };
      });

      const session = new ConversationSession(makeConfig());
      expect(session.isBusy).toBe(false);

      const promise = session.send("test");
      // After starting send, should be busy
      expect(session.isBusy).toBe(true);

      await promise;
      expect(session.isBusy).toBe(false);
    });
  });

  describe("stop_reason", () => {
    it("returns stopReason from result message", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield { type: "result", result: "Done", stop_reason: "end_turn" };
      });

      const session = new ConversationSession(makeConfig());
      const result = await session.send("test");

      expect(result.stopReason).toBe("end_turn");
    });

    it("returns error with stopReason=refusal for bot layer to handle", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield {
          type: "result",
          is_error: true,
          stop_reason: "refusal",
          errors: ["Request refused"],
        };
      });

      const session = new ConversationSession(makeConfig());
      const result = await session.send("do something bad");

      expect(result.error).toBe("Request refused");
      expect(result.stopReason).toBe("refusal");
    });

    it("returns null stopReason when not present", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield { type: "result", result: "OK" };
      });

      const session = new ConversationSession(makeConfig());
      const result = await session.send("test");

      expect(result.stopReason).toBeNull();
    });
  });

  describe("tool_use_summary events", () => {
    it("emits tool_summary progress event", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield {
          type: "tool_use_summary",
          summary: "Read 3 files and edited 1",
          preceding_tool_use_ids: ["t1", "t2", "t3"],
        };
        yield { type: "result", result: "Done" };
      });

      const events: ProgressEvent[] = [];
      const session = new ConversationSession(makeConfig());
      await session.send("refactor", { onProgress: (e) => events.push(e) });

      const summaryEvents = events.filter((e) => e.type === "tool_summary");
      expect(summaryEvents).toHaveLength(1);
      expect(summaryEvents[0]).toEqual({
        type: "tool_summary",
        summary: "Read 3 files and edited 1",
      });
    });
  });

  describe("task notification events", () => {
    it("emits task_status for task_started", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "task-1",
          description: "Running tests in background",
        };
        yield { type: "result", result: "Done" };
      });

      const events: ProgressEvent[] = [];
      const session = new ConversationSession(makeConfig());
      await session.send("run tests", { onProgress: (e) => events.push(e) });

      const taskEvents = events.filter((e) => e.type === "task_status");
      expect(taskEvents).toHaveLength(1);
      expect(taskEvents[0]).toEqual({
        type: "task_status",
        taskId: "task-1",
        status: "started",
        summary: "Running tests in background",
      });
    });

    it("emits task_status for task_notification completed", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield {
          type: "system",
          subtype: "task_notification",
          task_id: "task-2",
          status: "completed",
          summary: "Tests passed",
          output_file: "/tmp/output.txt",
        };
        yield { type: "result", result: "Done" };
      });

      const events: ProgressEvent[] = [];
      const session = new ConversationSession(makeConfig());
      await session.send("check", { onProgress: (e) => events.push(e) });

      const taskEvents = events.filter((e) => e.type === "task_status");
      expect(taskEvents).toHaveLength(1);
      expect(taskEvents[0]).toEqual({
        type: "task_status",
        taskId: "task-2",
        status: "completed",
        summary: "Tests passed",
      });
    });
  });

  describe("resume and forkSession", () => {
    it("passes resume and forkSession to SDK options", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "forked-1" };
        yield { type: "result", result: "Resumed" };
      });

      const session = new ConversationSession(
        makeConfig({ resume: "terminal-sess-123", forkSession: true }),
      );
      await session.send("hello");

      const call = mockQuery.mock.calls[0][0];
      expect(call.options.resume).toBe("terminal-sess-123");
      expect(call.options.forkSession).toBe(true);
    });

    it("does not set resume/forkSession when not provided", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield { type: "result", result: "OK" };
      });

      const session = new ConversationSession(makeConfig());
      await session.send("test");

      const call = mockQuery.mock.calls[0][0];
      expect(call.options.resume).toBeUndefined();
      expect(call.options.forkSession).toBeUndefined();
    });
  });

  describe("query options defaults", () => {
    it("sets systemPrompt preset with append", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "result", result: "OK" };
      });

      const session = new ConversationSession(makeConfig());
      await session.send("test");

      const call = mockQuery.mock.calls[0][0];
      expect(call.options.systemPrompt).toEqual({
        type: "preset",
        preset: "claude_code",
        append: expect.stringContaining("Microsoft Teams"),
      });
    });

    it("sets settingSources to project", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "result", result: "OK" };
      });

      const session = new ConversationSession(makeConfig());
      await session.send("test");

      const call = mockQuery.mock.calls[0][0];
      expect(call.options.settingSources).toEqual(["project"]);
    });
  });

  describe("close", () => {
    it("resolves pending turn with error on close", async () => {
      // Query that never produces a result
      let closeQuery: (() => void) | undefined;
      mockQuery.mockImplementation(() => {
        return {
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
          streamInput: vi.fn(),
          interrupt: vi.fn(),
          close: vi.fn(() => {
            closeQuery?.();
          }),
        };
      });

      const session = new ConversationSession(makeConfig());
      const promise = session.send("test");

      // Close while waiting
      session.close();

      const result = await promise;
      expect(result.error).toBe("Session closed");
    });
  });
});
