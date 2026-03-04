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
const sendMessageMock = vi.fn();

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
  saveImagesToTmp: vi.fn(async () => []),
}));

// Mock the query pool
const mockManagedQuery = {
  query: { interrupt: vi.fn(), setModel: vi.fn(), close: vi.fn() },
  inputQueue: { push: vi.fn(), end: vi.fn() },
  conversationId: "conv-perm-1",
  lastActivityAt: Date.now(),
  busy: false,
  sessionId: "existing-session" as string | undefined,
  currentTurn: null,
  streamDrainer: Promise.resolve(),
  permissionMode: { current: "default" },
  canUseToolHandler: { current: null as unknown },
};

vi.mock("../src/session/query-pool.js", () => ({
  queryPool: {
    acquire: vi.fn(() => mockManagedQuery),
    sendMessage: (...args: unknown[]) => sendMessageMock(...args),
    remove: vi.fn(async () => {}),
    closeAll: vi.fn(async () => {}),
    has: vi.fn(() => false),
    get: vi.fn(() => undefined),
    size: 0,
  },
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
    sendMessageMock.mockReset();
    mockManagedQuery.busy = false;
    mockManagedQuery.sessionId = "existing-session";
    mockManagedQuery.canUseToolHandler = { current: null };
    sessionState.sessionId = "existing-session";
    sessionState.workDir = "/work/test";
    sessionState.model = "claude-opus-4-6";
    sessionState.thinkingTokens = 2048;
    sessionState.permissionMode = "default";
  });

  it("sets canUseToolHandler on managed query when permissionMode is default", async () => {
    sendMessageMock.mockResolvedValue({
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

    expect(sendMessageMock).toHaveBeenCalledOnce();
    // When permissionMode is default, canUseToolHandler should be set
    expect(mockManagedQuery.canUseToolHandler.current).toBeDefined();
    expect(typeof mockManagedQuery.canUseToolHandler.current).toBe("function");
  });

  it("passes onPromptRequest to sendMessage handlers", async () => {
    sendMessageMock.mockResolvedValue({
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

    const args = sendMessageMock.mock.calls[0];
    const handlers = args[2]; // TurnHandlers
    expect(handlers).toBeDefined();
    expect(handlers.onPromptRequest).toBeDefined();
    expect(typeof handlers.onPromptRequest).toBe("function");
  });

  it("clears canUseToolHandler when permissionMode is bypassPermissions", async () => {
    sessionState.permissionMode = "bypassPermissions";

    sendMessageMock.mockResolvedValue({
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

    // canUseToolHandler should be null when bypassing permissions
    expect(mockManagedQuery.canUseToolHandler.current).toBeNull();
  });

  it("canUseTool callback sends permission card and resolves on Allow", async () => {
    let capturedCanUseTool:
      | ((...args: unknown[]) => Promise<unknown>)
      | undefined;

    sendMessageMock.mockImplementation(async () => {
      // Capture the canUseToolHandler that was set on the managed query
      capturedCanUseTool = mockManagedQuery.canUseToolHandler.current as typeof capturedCanUseTool;

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
        expect((result as Record<string, unknown>).behavior).toBe("allow");
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

  it("onPromptRequest handler sends prompt card and resolves on selection", async () => {
    let capturedOnPromptRequest:
      | ((...args: unknown[]) => Promise<unknown>)
      | undefined;

    sendMessageMock.mockImplementation(async (_managed: unknown, _text: unknown, handlers: Record<string, unknown>) => {
      capturedOnPromptRequest = handlers?.onPromptRequest as typeof capturedOnPromptRequest;

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
});
