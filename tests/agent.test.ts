/**
 * Agent tests - mock SDK to test Claude integration logic
 * Tests: runClaude options, fork/continue, progress events, error handling
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the SDK
const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => mockQuery(args),
}));

// Import after mock
import { runClaude, type ProgressEvent } from "../src/claude/agent.js";

describe("runClaude", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe("basic execution", () => {
    it("passes prompt to SDK", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-123" };
        yield { result: "Done!" };
      });

      await runClaude("hello world");

      expect(mockQuery).toHaveBeenCalledOnce();
      const call = mockQuery.mock.calls[0][0];
      expect(call.prompt).toBe("hello world");
    });

    it("returns session ID from init message", async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "new-session-456",
        };
        yield { result: "OK" };
      });

      const result = await runClaude("test");

      expect(result.sessionId).toBe("new-session-456");
    });

    it("returns result text", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "s1" };
        yield { result: "Here is my response" };
      });

      const result = await runClaude("test");

      expect(result.result).toBe("Here is my response");
    });
  });

  describe("fork/continue options", () => {
    it("sets forkSession=true when resume=fork", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "forked-123" };
        yield { result: "Forked!" };
      });

      await runClaude(
        "continue",
        "existing-session", // sessionId
        undefined, // workDir
        undefined, // model
        undefined, // thinkingTokens
        undefined, // permissionMode
        undefined, // images
        undefined, // onProgress
        { resume: "fork" }, // runOptions
      );

      const call = mockQuery.mock.calls[0][0];
      expect(call.options.resume).toBe("existing-session");
      expect(call.options.forkSession).toBe(true);
    });

    it("sets resume without forkSession when resume=continue", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "continued-123" };
        yield { result: "Continued!" };
      });

      await runClaude(
        "continue",
        "existing-session",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { resume: "continue" },
      );

      const call = mockQuery.mock.calls[0][0];
      expect(call.options.resume).toBe("existing-session");
      expect(call.options.forkSession).toBeUndefined();
    });

    it("uses cwd when no sessionId (new session)", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: "system", subtype: "init", session_id: "new-1" };
        yield { result: "New session" };
      });

      await runClaude("start", undefined, "/home/user/project");

      const call = mockQuery.mock.calls[0][0];
      expect(call.options.cwd).toBe("/home/user/project");
      expect(call.options.resume).toBeUndefined();
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
        yield { result: "Done" };
      });

      const events: ProgressEvent[] = [];
      await runClaude(
        "run tests",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        (e) => events.push(e),
      );

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        type: "tool_use",
        tool: { name: "Bash", command: "npm test" },
      });
      expect(events[1]).toEqual({
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
        yield { result: "Done" };
      });

      const events: ProgressEvent[] = [];
      await runClaude(
        "test",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        (e) => events.push(e),
      );

      expect(events[0].tool.command?.length).toBe(100);
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
        yield { result: "Done" };
      });

      const result = await runClaude("write something");

      expect(result.tools).toHaveLength(1);
      expect(result.tools[0]).toEqual({
        name: "Write",
        file: "output.txt",
      });
    });
  });

  describe("error handling", () => {
    it("returns error message when SDK throws", async () => {
      mockQuery.mockImplementation(async function* (_ctx) {
        throw new Error("API rate limited");
      });

      const result = await runClaude("test");

      expect(result.error).toBe("API rate limited");
      expect(result.tools).toEqual([]);
    });

    it("truncates long error messages", async () => {
      mockQuery.mockImplementation(async function* (_ctx) {
        throw new Error("x".repeat(1000));
      });

      const result = await runClaude("test");

      expect(result.error?.length).toBe(500);
    });
  });

  describe("permission mode", () => {
    it("uses bypassPermissions by default", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { result: "OK" };
      });

      await runClaude("test");

      const call = mockQuery.mock.calls[0][0];
      expect(call.options.permissionMode).toBe("bypassPermissions");
    });

    it("uses provided permissionMode", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { result: "OK" };
      });

      await runClaude(
        "test",
        undefined,
        undefined,
        undefined,
        undefined,
        "default",
      );

      const call = mockQuery.mock.calls[0][0];
      expect(call.options.permissionMode).toBe("default");
    });
  });

  describe("model and thinking tokens", () => {
    it("passes model to options", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { result: "OK" };
      });

      await runClaude("test", undefined, undefined, "claude-3-opus");

      const call = mockQuery.mock.calls[0][0];
      expect(call.options.model).toBe("claude-3-opus");
    });

    it("passes maxThinkingTokens when provided", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { result: "OK" };
      });

      await runClaude("test", undefined, undefined, undefined, 8000);

      const call = mockQuery.mock.calls[0][0];
      expect(call.options.maxThinkingTokens).toBe(8000);
    });

    it("skips maxThinkingTokens when null", async () => {
      mockQuery.mockImplementation(async function* () {
        yield { result: "OK" };
      });

      await runClaude("test", undefined, undefined, undefined, null);

      const call = mockQuery.mock.calls[0][0];
      expect(call.options.maxThinkingTokens).toBeUndefined();
    });
  });
});

describe("canUseTool callback", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("passes canUseTool to SDK options", async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: "system", subtype: "init", session_id: "test-session" };
      yield { result: "Done" };
    });

    const canUseTool = vi.fn().mockResolvedValue({ behavior: "allow" });

    await runClaude(
      "test prompt",
      undefined, // sessionId
      undefined, // workDir
      undefined, // model
      undefined, // thinkingTokens
      undefined, // permissionMode
      undefined, // images
      undefined, // onProgress
      { canUseTool }, // runOptions with canUseTool
    );

    // Verify canUseTool was passed
    const call = mockQuery.mock.calls[0][0];
    expect(call.options.canUseTool).toBe(canUseTool);
  });

  it("does not pass canUseTool when not provided", async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: "system", subtype: "init", session_id: "test-session" };
      yield { result: "Done" };
    });

    await runClaude("test prompt");

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.canUseTool).toBeUndefined();
  });
});
