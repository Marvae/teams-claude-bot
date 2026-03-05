/**
 * Integration test: Full Teams permission + user-input flow
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TestAdapter, TurnContext, ActivityTypes, type Activity } from "botbuilder";

// ---- Mocks ----

const mockQuery = vi.fn();

const stateValues = {
  sessionId: undefined as string | undefined,
  workDir: "/work/test",
  model: "claude-opus-4-6" as string | undefined,
  thinkingTokens: 2048 as number | null | undefined,
  permissionMode: "default",
  managed: null as unknown,
};

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => mockQuery(args),
  listSessions: vi.fn().mockResolvedValue([]),
  getSessionMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/handoff/store.js", () => ({
  saveConversationRef: vi.fn(),
}));

vi.mock("../src/session/state.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    loadPersistedSessionId: vi.fn(() => stateValues.sessionId),
    persistSessionId: vi.fn((id: string) => {
      stateValues.sessionId = id;
    }),
    clearPersistedSessionId: vi.fn(() => {
      stateValues.sessionId = undefined;
    }),
    getSession: vi.fn(() => stateValues.managed),
    setSession: vi.fn((m: unknown) => {
      stateValues.managed = m;
    }),
    destroySession: vi.fn(() => {
      if (stateValues.managed) {
        (
          stateValues.managed as { session: { close: () => void } }
        ).session.close();
      }
      stateValues.managed = null;
    }),
    getWorkDir: vi.fn(() => stateValues.workDir),
    setWorkDir: vi.fn(),
    getModel: vi.fn(() => stateValues.model),
    setModel: vi.fn(),
    getThinkingTokens: vi.fn(() => stateValues.thinkingTokens),
    setThinkingTokens: vi.fn(),
    getPermissionMode: vi.fn(() => stateValues.permissionMode),
    setPermissionMode: vi.fn(),
    getHandoffMode: vi.fn(() => undefined),
    setHandoffMode: vi.fn(),
    clearHandoffMode: vi.fn(),
    getCachedCommands: vi.fn(() => undefined),
    setCachedCommands: vi.fn(),
  };
});

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
  const adapter = new TestAdapter(async (context) => {
    await bot.run(context);
  });
  // Patch continueConversation for proactive messaging
  (adapter as Record<string, unknown>).continueConversation = async (
    _ref: unknown,
    callback: (ctx: TurnContext) => Promise<void>,
  ) => {
    const activity = {
      type: "event",
      channelId: "test",
      conversation: { id: "conv-1" },
      from: { id: "bot", name: "Bot" },
      recipient: { id: "user", name: "User" },
      serviceUrl: "https://test",
    } as Activity;
    const ctx = new TurnContext(adapter, activity);
    ctx.onSendActivities(async (_ctx, activities, next) => {
      for (const a of activities) {
        (adapter as unknown as { activeQueue: unknown[] }).activeQueue.push(a);
      }
      return await next();
    });
    await callback(ctx);
  };
  return adapter;
}

function assertInformativeTyping(activity: Partial<Activity>): void {
  expect(activity.type).toBe(ActivityTypes.Typing);
  expect(activity.channelData).toMatchObject({ streamType: "informative" });
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
    stateValues.managed = null;
    stateValues.sessionId = "existing-session";
    stateValues.workDir = "/work/test";
    stateValues.model = "claude-opus-4-6";
    stateValues.thinkingTokens = 2048;
    stateValues.permissionMode = "default";
  });

  it("passes canUseTool to SDK when permissionMode is default", async () => {
    setupMockQuery("Done", "sess-1");

    const adapter = createAdapter();

    await adapter
      .send(makeActivity("Write a file"))

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

      .assertReply((activity) => {
        expect(activity.text).toBe("Done");
      })
      .startTest();

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.onElicitation).toBeDefined();
    expect(typeof call.options.onElicitation).toBe("function");
  });

  it("still passes canUseTool when permissionMode is bypassPermissions", async () => {
    stateValues.permissionMode = "bypassPermissions";
    setupMockQuery("Done fast", "sess-3");

    const adapter = createAdapter();

    await adapter
      .send(makeActivity("Do stuff"))

      .assertReply((activity) => {
        expect(activity.text).toBe("Done fast");
      })
      .startTest();

    const call = mockQuery.mock.calls[0][0];
    expect(call.options.canUseTool).toBeDefined();
  });

  it("canUseTool callback sends permission card and resolves on Allow", async () => {
    let capturedCanUseTool:
      | ((...args: unknown[]) => Promise<unknown>)
      | undefined;

    mockQuery.mockImplementation(
      (args: { options: Record<string, unknown> }) => {
        capturedCanUseTool = args.options
          .canUseTool as typeof capturedCanUseTool;

        return (async function* () {
          yield { type: "system", subtype: "init", session_id: "sess-perm" };

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

      .assertReply(() => {
        // Elicitation card or result
      })
      .startTest();

    expect(capturedOnElicitation).toBeDefined();
  });
});
