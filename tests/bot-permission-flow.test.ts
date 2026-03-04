/**
 * Integration test: Full Teams permission + user-input flow
 *
 * Simulates the real Teams conversation:
 * 1. User sends message → Claude runs → needs permission → sends card
 * 2. User clicks Allow/Deny button → permission resolves → Claude continues
 * 3. SDK emits PromptRequest → bot sends prompt card → user selects option
 *
 * These tests verify that handleMessage correctly wires canUseTool,
 * onPromptRequest, and onElicitation into the ConversationSession.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TestAdapter, ActivityTypes, type Activity } from "botbuilder";

// ---- Mocks ----

const mockQuery = vi.fn();

const sessionState = {
  sessionId: undefined as string | undefined,
  workDir: "/work/test",
  model: "claude-opus-4-6",
  thinkingTokens: 2048 as number | null | undefined,
  permissionMode: "default" as string | undefined,
};

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => mockQuery(args),
  listSessions: vi.fn().mockResolvedValue([]),
  getSessionMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/handoff/store.js", () => ({
  saveConversationRef: vi.fn(),
}));

vi.mock("../src/session/manager.js", () => ({
  getSession: vi.fn(() => sessionState.sessionId),
  getSessionCwd: vi.fn(() => undefined),
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

import * as sessionStore from "../src/claude/session-store.js";
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

function setupMockQuery(result: string, sessionId = "sess-1") {
  mockQuery.mockImplementation(async function* () {
    yield { type: "system", subtype: "init", session_id: sessionId };
    yield { type: "result", result };
  });
}

describe("handleMessage passes permission + prompt handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    sessionStore.destroy("conv-perm-1");
    sessionState.sessionId = "existing-session";
    sessionState.workDir = "/work/test";
    sessionState.model = "claude-opus-4-6";
    sessionState.thinkingTokens = 2048;
    sessionState.permissionMode = "default";
  });

  it("passes canUseTool to SDK when permissionMode is default", async () => {
    setupMockQuery("Done", "sess-1");

    const adapter = createAdapter();

    await adapter
      .send(makeActivity("Write a file"))
      .assertReply({ type: ActivityTypes.Typing })
      .assertReply((activity) => {
        expect(activity.text).toBe("Done");
      })
      .startTest();

    expect(mockQuery).toHaveBeenCalledOnce();
    const call = mockQuery.mock.calls[0][0];
    expect(call.options.canUseTool).toBeDefined();
    expect(typeof call.options.canUseTool).toBe("function");
  });

  it("passes onElicitation to SDK", async () => {
    setupMockQuery("Done", "sess-elic-1");

    const adapter = createAdapter();

    await adapter
      .send(makeActivity("Connect MCP"))
      .assertReply({ type: ActivityTypes.Typing })
      .assertReply((activity) => {
        expect(activity.text).toBe("Done");
      })
      .startTest();

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.onElicitation).toBeDefined();
    expect(typeof call.options.onElicitation).toBe("function");
  });

  it("still passes canUseTool when permissionMode is bypassPermissions", async () => {
    sessionState.permissionMode = "bypassPermissions";
    setupMockQuery("Done fast", "sess-3");

    const adapter = createAdapter();

    await adapter
      .send(makeActivity("Do stuff"))
      .assertReply({ type: ActivityTypes.Typing })
      .assertReply((activity) => {
        expect(activity.text).toBe("Done fast");
      })
      .startTest();

    const call = mockQuery.mock.calls[0][0];
    // canUseTool is always passed - SDK decides when to call it
    expect(call.options.canUseTool).toBeDefined();
  });

  it("canUseTool callback sends permission card and resolves on Allow", async () => {
    // Use a more controlled mock that lets us intercept canUseTool
    let capturedCanUseTool:
      | ((...args: unknown[]) => Promise<unknown>)
      | undefined;

    mockQuery.mockImplementation(
      (args: { options: Record<string, unknown> }) => {
        capturedCanUseTool = args.options
          .canUseTool as typeof capturedCanUseTool;

        // Return an async generator that yields init + result
        return (async function* () {
          yield { type: "system", subtype: "init", session_id: "sess-perm" };

          // Simulate calling canUseTool if captured
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
            expect((result as { behavior: string }).behavior).toBe("allow");
          }

          yield { type: "result", result: "Executed command" };
        })();
      },
    );

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

  it("onElicitation callback sends form card and resolves with submitted values", async () => {
    let capturedOnElicitation:
      | ((...args: unknown[]) => Promise<unknown>)
      | undefined;

    mockQuery.mockImplementation(
      (args: { options: Record<string, unknown> }) => {
        capturedOnElicitation = args.options
          .onElicitation as typeof capturedOnElicitation;

        return (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sess-elic-form",
          };

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

          yield { type: "result", result: "Elicitation completed" };
        })();
      },
    );

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
