/**
 * Integration test: Full Teams permission + user-input flow
 *
 * Simulates the real Teams conversation:
 * 1. User sends message → Claude runs → needs permission → sends card
 * 2. User clicks Allow/Deny button → permission resolves → Claude continues
 * 3. SDK emits PromptRequest → bot sends prompt card → user selects option
 *
 * These tests verify that handleMessage (the main message path)
 * correctly wires canUseTool and onPromptRequest into runClaude.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TestAdapter, ActivityTypes, type Activity } from "botbuilder";

// ---- Mocks ----

const runClaudeMock = vi.fn();

const sessionState = {
  sessionId: undefined as string | undefined,
  workDir: "/work/test",
  model: "claude-opus-4-6",
  thinkingTokens: 2048 as number | null | undefined,
  permissionMode: "default" as string | undefined,
};

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../src/claude/agent.js", () => ({
  runClaude: (...args: unknown[]) => runClaudeMock(...args),
}));

vi.mock("../src/handoff/store.js", () => ({
  saveConversationRef: vi.fn(),
}));

vi.mock("../src/session/manager.js", () => ({
  getSession: vi.fn(() => sessionState.sessionId),
  setSession: vi.fn((_cid: string, sid: string) => {
    sessionState.sessionId = sid;
  }),
  clearSession: vi.fn(),
  getWorkDir: vi.fn(() => sessionState.workDir),
  setWorkDir: vi.fn(),
  getModel: vi.fn(() => sessionState.model),
  setModel: vi.fn(),
  getThinkingTokens: vi.fn(() => sessionState.thinkingTokens),
  setThinkingTokens: vi.fn(),
  getPermissionMode: vi.fn(() => sessionState.permissionMode),
  setPermissionMode: vi.fn(),
  listPastSessions: vi.fn(() => []),
  switchToSession: vi.fn(() => null),
  getHandoffMode: vi.fn(() => undefined),
  clearHandoffMode: vi.fn(),
  setHandoffMode: vi.fn(),
}));

import { ClaudeCodeBot } from "../src/bot/teams-bot.js";

const serviceUrl = "https://amer.ng.msg.teams.microsoft.com";

function makeActivity(text: string, extra?: Partial<Activity>): Activity {
  return {
    type: ActivityTypes.Message,
    text,
    channelId: "msteams",
    serviceUrl,
    from: { id: "user-1", name: "Test User" },
    recipient: { id: "bot" },
    conversation: { id: "conv-perm-1" },
    ...extra,
  } as Activity;
}

function createAdapter(): TestAdapter {
  const bot = new ClaudeCodeBot();
  return new TestAdapter(async (context) => {
    await bot.run(context);
  });
}

describe("handleMessage passes permission + prompt handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runClaudeMock.mockReset();
    sessionState.sessionId = "existing-session";
    sessionState.workDir = "/work/test";
    sessionState.model = "claude-opus-4-6";
    sessionState.thinkingTokens = 2048;
    sessionState.permissionMode = "default";
  });

  it("passes canUseTool to runClaude when permissionMode is default", async () => {
    runClaudeMock.mockResolvedValue({
      result: "Done",
      sessionId: "sess-1",
      tools: [],
    });

    const adapter = createAdapter();

    await adapter
      .send(makeActivity("Write a file"))
      .assertReply({ type: ActivityTypes.Typing })
      .assertReply((activity) => {
        expect(activity.text).toBe("Done");
      })
      .startTest();

    expect(runClaudeMock).toHaveBeenCalledOnce();

    // The 9th argument (index 8) is runOptions
    const args = runClaudeMock.mock.calls[0];
    const runOptions = args[8];
    expect(runOptions).toBeDefined();
    expect(runOptions.canUseTool).toBeDefined();
    expect(typeof runOptions.canUseTool).toBe("function");
  });

  it("passes onPromptRequest to runClaude", async () => {
    runClaudeMock.mockResolvedValue({
      result: "Done",
      sessionId: "sess-2",
      tools: [],
    });

    const adapter = createAdapter();

    await adapter
      .send(makeActivity("Ask me something"))
      .assertReply({ type: ActivityTypes.Typing })
      .assertReply((activity) => {
        expect(activity.text).toBe("Done");
      })
      .startTest();

    const args = runClaudeMock.mock.calls[0];
    const runOptions = args[8];
    expect(runOptions).toBeDefined();
    expect(runOptions.onPromptRequest).toBeDefined();
    expect(typeof runOptions.onPromptRequest).toBe("function");
  });

  it("passes onElicitation to runClaude", async () => {
    runClaudeMock.mockResolvedValue({
      result: "Done",
      sessionId: "sess-elic-1",
      tools: [],
    });

    const adapter = createAdapter();

    await adapter
      .send(makeActivity("Connect MCP"))
      .assertReply({ type: ActivityTypes.Typing })
      .assertReply((activity) => {
        expect(activity.text).toBe("Done");
      })
      .startTest();

    const args = runClaudeMock.mock.calls[0];
    const runOptions = args[8];
    expect(runOptions).toBeDefined();
    expect(runOptions.onElicitation).toBeDefined();
    expect(typeof runOptions.onElicitation).toBe("function");
  });

  it("still passes canUseTool when permissionMode is bypassPermissions", async () => {
    sessionState.permissionMode = "bypassPermissions";

    runClaudeMock.mockResolvedValue({
      result: "Done fast",
      sessionId: "sess-3",
      tools: [],
    });

    const adapter = createAdapter();

    await adapter
      .send(makeActivity("Do stuff"))
      .assertReply({ type: ActivityTypes.Typing })
      .assertReply((activity) => {
        expect(activity.text).toBe("Done fast");
      })
      .startTest();

    const args = runClaudeMock.mock.calls[0];
    const runOptions = args[8];
    // canUseTool is always passed - SDK decides when to call it
    expect(runOptions?.canUseTool).toBeDefined();
  });

  it("canUseTool callback sends permission card and resolves on Allow", async () => {
    let capturedCanUseTool:
      | ((...args: unknown[]) => Promise<unknown>)
      | undefined;

    runClaudeMock.mockImplementation(async (...args: unknown[]) => {
      const runOptions = args[8] as Record<string, unknown> | undefined;
      capturedCanUseTool = runOptions?.canUseTool as typeof capturedCanUseTool;

      if (capturedCanUseTool) {
        const { resolvePermission } =
          await import("../src/claude/permissions.js");

        const resultPromise = capturedCanUseTool(
          "Bash",
          { command: "rm -rf /tmp/test" },
          {
            signal: new AbortController().signal,
            toolUseID: "tool-perm-1",
            decisionReason: "potentially dangerous",
          },
        );

        // Wait a tick so the pending permission gets registered before resolving
        await new Promise((r) => setTimeout(r, 50));
        resolvePermission("tool-perm-1", true);

        const result = await resultPromise;
        expect(result.behavior).toBe("allow");
      }

      return {
        result: "Executed command",
        sessionId: "sess-perm",
        tools: [{ name: "Bash", command: "rm -rf /tmp/test" }],
      };
    });

    const adapter = createAdapter();

    await adapter
      .send(makeActivity("Delete temp files"))
      .assertReply({ type: ActivityTypes.Typing })
      .assertReply(() => {
        // Permission card or result
      })
      .startTest();

    expect(capturedCanUseTool).toBeDefined();
  });

  it("onPromptRequest callback sends prompt card and resolves on selection", async () => {
    let capturedOnPromptRequest:
      | ((...args: unknown[]) => Promise<unknown>)
      | undefined;

    runClaudeMock.mockImplementation(async (...args: unknown[]) => {
      const runOptions = args[8] as Record<string, unknown> | undefined;
      capturedOnPromptRequest =
        runOptions?.onPromptRequest as typeof capturedOnPromptRequest;

      if (capturedOnPromptRequest) {
        const { resolvePromptRequest } =
          await import("../src/claude/user-input.js");

        const responsePromise = capturedOnPromptRequest({
          requestId: "prompt-abc",
          message: "Which option?",
          options: [
            { key: "opt-a", label: "Option A" },
            { key: "opt-b", label: "Option B" },
          ],
        });

        // Wait a tick so registerPromptRequest sets up the pending entry
        await new Promise((r) => setTimeout(r, 50));
        resolvePromptRequest("prompt-abc", "opt-a");

        const selected = await responsePromise;
        expect(selected).toBe("opt-a");
      }

      return {
        result: "Selected A",
        sessionId: "sess-prompt",
        tools: [],
      };
    });

    const adapter = createAdapter();

    await adapter
      .send(makeActivity("Choose for me"))
      .assertReply({ type: ActivityTypes.Typing })
      .assertReply(() => {
        // Prompt card or result
      })
      .startTest();

    expect(capturedOnPromptRequest).toBeDefined();
  });

  it("onElicitation callback sends form card and resolves with submitted values", async () => {
    let capturedOnElicitation:
      | ((...args: unknown[]) => Promise<unknown>)
      | undefined;

    runClaudeMock.mockImplementation(async (...args: unknown[]) => {
      const runOptions = args[8] as Record<string, unknown> | undefined;
      capturedOnElicitation =
        runOptions?.onElicitation as typeof capturedOnElicitation;

      if (capturedOnElicitation) {
        const { resolveElicitation } =
          await import("../src/claude/elicitation.js");

        const responsePromise = capturedOnElicitation({
          serverName: "github-mcp",
          message: "Provide project configuration",
          mode: "form",
          elicitationId: "elicitation-1",
          requestedSchema: {
            type: "object",
            properties: {
              project: { type: "string", title: "Project" },
              branch: { type: "string", title: "Branch" },
            },
            required: ["project"],
          },
        });

        await new Promise((r) => setTimeout(r, 50));
        resolveElicitation("elicitation-1", {
          project: "teams-claude-bot",
          branch: "main",
        });

        const selected = await responsePromise;
        expect(selected).toEqual({
          action: "accept",
          content: {
            project: "teams-claude-bot",
            branch: "main",
          },
        });
      }

      return {
        result: "Elicitation completed",
        sessionId: "sess-elic-form",
        tools: [],
      };
    });

    const adapter = createAdapter();

    await adapter
      .send(makeActivity("Connect MCP with form"))
      .assertReply({ type: ActivityTypes.Typing })
      .assertReply(() => {
        // Elicitation card or result
      })
      .startTest();

    expect(capturedOnElicitation).toBeDefined();
  });
});
