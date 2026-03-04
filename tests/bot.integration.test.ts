import { describe, it, expect, vi, beforeEach } from "vitest";
import { TestAdapter, ActivityTypes, type Activity } from "botbuilder";

// ---- Mock SDK query to return controlled results ----
const mockQuery = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => mockQuery(args),
  listSessions: vi.fn().mockResolvedValue([]),
  getSessionMessages: vi.fn().mockResolvedValue([]),
}));

const sessionState = {
  sessionId: undefined as string | undefined,
  sessionCwd: undefined as string | undefined,
  workDir: "/work/test",
  model: "claude-opus-4-6",
  thinkingTokens: 2048 as number | null | undefined,
  permissionMode: "bypassPermissions" as string | undefined,
  pastSessions: [] as Array<{
    index: number;
    sessionId: string;
    workDir: string;
    usedAt: string;
  }>,
  switchResult: null as {
    index: number;
    sessionId: string;
    workDir: string;
    usedAt: string;
  } | null,
  handoffMode: undefined as "pickup" | undefined,
};

vi.mock("../src/handoff/store.js", () => ({
  saveConversationRef: vi.fn(),
}));

vi.mock("../src/session/manager.js", () => ({
  getSession: vi.fn(() => sessionState.sessionId),
  getSessionCwd: vi.fn(() => sessionState.sessionCwd),
  setSession: vi.fn(
    (_conversationId: string, sessionId: string, cwd?: string) => {
      sessionState.sessionId = sessionId;
      sessionState.sessionCwd = cwd;
    },
  ),
  clearSession: vi.fn(() => {
    sessionState.sessionId = undefined;
    sessionState.sessionCwd = undefined;
  }),
  getWorkDir: vi.fn(() => sessionState.workDir),
  setWorkDir: vi.fn((_conversationId: string, dir: string) => {
    sessionState.workDir = dir;
    return { ok: true } as const;
  }),
  getModel: vi.fn(() => sessionState.model),
  setModel: vi.fn((_conversationId: string, model: string) => {
    sessionState.model = model;
  }),
  getThinkingTokens: vi.fn(() => sessionState.thinkingTokens),
  setThinkingTokens: vi.fn((_conversationId: string, tokens: number | null) => {
    sessionState.thinkingTokens = tokens;
  }),
  getPermissionMode: vi.fn(() => sessionState.permissionMode),
  setPermissionMode: vi.fn((_conversationId: string, mode: string) => {
    sessionState.permissionMode = mode;
  }),
  listPastSessions: vi.fn(() => sessionState.pastSessions),
  switchToSession: vi.fn((_conversationId: string, index: number) => {
    if (
      sessionState.switchResult &&
      sessionState.switchResult.index === index
    ) {
      return sessionState.switchResult;
    }
    return null;
  }),
  getHandoffMode: vi.fn(() => sessionState.handoffMode),
  clearHandoffMode: vi.fn(),
  setHandoffMode: vi.fn(),
}));

import * as sessionManager from "../src/session/manager.js";
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
    conversation: { id: "conv-1" },
    ...extra,
  } as Activity;
}

function createAdapter(): TestAdapter {
  const bot = new ClaudeCodeBot();
  return new TestAdapter(async (context) => {
    await bot.run(context);
  });
}

/** Extract the user text from the async generator prompt passed to SDK query. */
async function extractPromptText(
  prompt: AsyncGenerator<{ message: { content: string } }>,
): Promise<string> {
  const first = await prompt.next();
  return first.value.message.content;
}

/** Helper: set up mockQuery to yield init + result messages */
function setupMockQuery(result: string, sessionId = "sess-123") {
  mockQuery.mockImplementation(async function* () {
    yield { type: "system", subtype: "init", session_id: sessionId };
    yield { type: "result", result };
  });
}

describe("ClaudeCodeBot e2e (TestAdapter)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    // Destroy any lingering sessions from previous tests
    sessionStore.destroy("conv-1");
    sessionState.sessionId = undefined;
    sessionState.sessionCwd = undefined;
    sessionState.workDir = "/work/test";
    sessionState.model = "claude-opus-4-6";
    sessionState.thinkingTokens = 2048;
    sessionState.permissionMode = "bypassPermissions";
    sessionState.pastSessions = [];
    sessionState.switchResult = null;
    sessionState.handoffMode = undefined;
  });

  it("handles basic message flow", async () => {
    setupMockQuery("Hello from Claude", "sess-123");

    const adapter = createAdapter();

    await adapter
      .send(makeActivity("Hello"))
      .assertReply({ type: ActivityTypes.Typing })
      .assertReply((activity) => {
        expect(activity.type).toBe(ActivityTypes.Message);
        expect(activity.text).toBe("Hello from Claude");
      })
      .startTest();

    expect(mockQuery).toHaveBeenCalledOnce();
    const call = mockQuery.mock.calls[0][0];
    expect(await extractPromptText(call.prompt)).toBe("Hello");
    expect(call.options.cwd).toBe("/work/test");
    expect(call.options.permissionMode).toBe("bypassPermissions");

    expect(vi.mocked(sessionManager.setSession)).toHaveBeenCalledWith(
      "conv-1",
      "sess-123",
      "/work/test",
    );
  });

  it("handles /help command with Adaptive Card", async () => {
    const adapter = createAdapter();

    await adapter
      .send(makeActivity("/help"))
      .assertReply((activity) => {
        expect(activity.type).toBe(ActivityTypes.Message);
        expect(activity.attachments?.[0].contentType).toBe(
          "application/vnd.microsoft.card.adaptive",
        );
        expect(activity.attachments?.[0].content).toMatchObject({
          type: "AdaptiveCard",
        });
      })
      .startTest();

    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("handles /status command", async () => {
    sessionState.sessionId = "sess-abcdef123456";
    sessionState.workDir = "/work/demo";
    sessionState.model = "claude-sonnet-4-6";
    sessionState.thinkingTokens = 4096;
    sessionState.permissionMode = "default";

    const adapter = createAdapter();

    await adapter
      .send(makeActivity("/status"))
      .assertReply((activity) => {
        expect(activity.type).toBe(ActivityTypes.Message);
        expect(activity.text).toContain("**Session:**");
        expect(activity.text).toContain("sess-abcdef1");
        expect(activity.text).toContain("**Work dir:** `/work/demo`");
        expect(activity.text).toContain("**Model:** `claude-sonnet-4-6`");
        expect(activity.text).toContain("**Thinking:** `4096` tokens");
        expect(activity.text).toContain("**Permission:** `default`");
      })
      .startTest();
  });

  it("handles /new command", async () => {
    const adapter = createAdapter();

    await adapter
      .send(makeActivity("/new"))
      .assertReply("New session. Send your next message.")
      .startTest();

    expect(vi.mocked(sessionManager.clearSession)).toHaveBeenCalledWith(
      "conv-1",
    );
  });

  it("handles adaptive card resume action", async () => {
    const adapter = createAdapter();
    const activity = makeActivity("", {
      value: { action: "resume_session", sessionId: "sess-old" },
    });

    await adapter
      .send(activity)
      .assertReply((reply) => {
        expect(reply.type).toBe(ActivityTypes.Message);
        expect(reply.text).toContain("Resumed session");
        expect(reply.text).toContain("sess-old");
      })
      .startTest();

    expect(vi.mocked(sessionManager.setSession)).toHaveBeenCalledWith(
      "conv-1",
      "sess-old",
      undefined,
    );
  });

  it("resume action stores session cwd alongside sessionId", async () => {
    const adapter = createAdapter();
    const activity = makeActivity("", {
      value: {
        action: "resume_session",
        sessionId: "sess-abc",
        cwd: "/work/other-project",
      },
    });

    await adapter
      .send(activity)
      .assertReply((reply) => {
        expect(reply.text).toContain("Resumed session");
        expect(reply.text).toContain("/work/other-project");
      })
      .startTest();

    expect(vi.mocked(sessionManager.setSession)).toHaveBeenCalledWith(
      "conv-1",
      "sess-abc",
      "/work/other-project",
    );
  });

  it("resume action works without cwd", async () => {
    const adapter = createAdapter();
    const activity = makeActivity("", {
      value: { action: "resume_session", sessionId: "sess-no-cwd" },
    });

    await adapter
      .send(activity)
      .assertReply((reply) => {
        expect(reply.text).toContain("Resumed session");
        expect(reply.text).not.toContain("📂");
      })
      .startTest();

    expect(vi.mocked(sessionManager.setSession)).toHaveBeenCalledWith(
      "conv-1",
      "sess-no-cwd",
      undefined,
    );
  });

  it("handles adaptive card resume action when sessionId missing", async () => {
    const adapter = createAdapter();
    const activity = makeActivity("", {
      value: { action: "resume_session" },
    });

    await adapter.send(activity).assertReply("Session not found.").startTest();
  });
});

describe("permission card interactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    sessionStore.destroy("conv-1");
    sessionStore.destroy("conv-perm-1");
    sessionState.sessionId = undefined;
    sessionState.permissionMode = "bypassPermissions";
  });

  it("handles /permission command with card", async () => {
    const adapter = createAdapter();
    await adapter.send("/permission").assertReply((reply) => {
      expect(reply.attachments).toBeDefined();
      expect(reply.attachments?.length).toBe(1);
      const card = reply.attachments![0].content as Record<string, unknown>;
      expect(card.type).toBe("AdaptiveCard");
      const actions = card.actions as Array<Record<string, unknown>>;
      expect(actions.length).toBe(5);
      const modeIds = actions.map((a) => (a.data as { mode: string }).mode);
      expect(modeIds).toEqual(
        expect.arrayContaining([
          "default",
          "acceptEdits",
          "plan",
          "dontAsk",
          "bypassPermissions",
        ]),
      );
      const titles = actions.map((a) => a.title);
      expect(titles).toContain(
        "Plan mode - Claude explains what it would do without executing",
      );
      expect(titles).toContain(
        "Don't ask - Auto-approve all tools (less strict than bypass)",
      );
    });
  });

  it("handles /permission plan", async () => {
    setupMockQuery("Plan response", "sess-plan-1");

    const adapter = createAdapter();

    await adapter
      .send(makeActivity("/permission plan"))
      .assertReply("Permission mode set to `plan`")
      .startTest();

    await adapter
      .send(makeActivity("Run in plan mode"))
      .assertReply({ type: ActivityTypes.Typing })
      .assertReply((activity) => {
        expect(activity.text).toBe("Plan response");
      })
      .startTest();

    expect(mockQuery).toHaveBeenCalled();
    const call = mockQuery.mock.calls[0][0];
    expect(call.options.permissionMode).toBe("plan");
  });

  it("handles /permission dontAsk", async () => {
    setupMockQuery("Auto-approve response", "sess-dont-1");

    const adapter = createAdapter();

    await adapter
      .send(makeActivity("/permission dontAsk"))
      .assertReply("Permission mode set to `dontAsk`")
      .startTest();

    await adapter
      .send(makeActivity("Run in dontAsk mode"))
      .assertReply({ type: ActivityTypes.Typing })
      .assertReply((activity) => {
        expect(activity.text).toBe("Auto-approve response");
      })
      .startTest();

    expect(mockQuery).toHaveBeenCalled();
    const call = mockQuery.mock.calls[0][0];
    expect(call.options.permissionMode).toBe("dontAsk");
  });

  it("handles set_permission_mode action", async () => {
    const adapter = createAdapter();
    await adapter
      .send({
        type: ActivityTypes.Message,
        value: {
          action: "set_permission_mode",
          mode: "acceptEdits",
        },
      })
      .assertReply((reply) => {
        expect(reply.text).toContain("acceptEdits");
      });
  });

  it("handles permission_allow action for unknown toolUseID", async () => {
    const adapter = createAdapter();
    await adapter
      .send({
        type: ActivityTypes.Message,
        value: {
          action: "permission_allow",
          toolUseID: "nonexistent-123",
        },
      })
      .assertReply((reply) => {
        expect(reply.text).toContain("expired");
      });
  });

  it("handles permission_deny action for unknown toolUseID", async () => {
    const adapter = createAdapter();
    await adapter
      .send({
        type: ActivityTypes.Message,
        value: {
          action: "permission_deny",
          toolUseID: "nonexistent-456",
        },
      })
      .assertReply((reply) => {
        expect(reply.text).toContain("expired");
      });
  });
});

describe("user input (PromptRequest) flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStore.destroy("conv-1");
  });

  it("handles prompt_response action", async () => {
    const adapter = createAdapter();
    await adapter
      .send({
        type: ActivityTypes.Message,
        value: {
          action: "prompt_response",
          requestId: "nonexistent-prompt",
          key: "yes",
        },
      })
      .assertReply((reply) => {
        // Should say expired/not found since we didn't register it
        expect(reply.text).toContain("expired");
      });
  });

  it("handles prompt_response with valid pending request", async () => {
    const { registerPromptRequest } =
      await import("../src/claude/user-input.js");

    // Register a pending prompt first
    const promptPromise = registerPromptRequest("test-prompt-123", {
      timeoutMs: 5000,
    });

    const adapter = createAdapter();
    await adapter
      .send({
        type: ActivityTypes.Message,
        value: {
          action: "prompt_response",
          requestId: "test-prompt-123",
          key: "confirm",
        },
      })
      .assertReply((reply) => {
        expect(reply.text).toContain("confirm");
      });

    // Prompt should resolve
    const result = await promptPromise;
    expect(result).toBe("confirm");
  });
});

describe("handoff flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    sessionStore.destroy("conv-1");
    sessionState.sessionId = undefined;
  });

  // Note: handoff_fork uses continueConversation which doesn't work in TestAdapter
  // The actual handler is tested via handleHandoff unit tests

  it("handles /handoff back command", async () => {
    // Set handoff mode first
    sessionState.handoffMode = "pickup";

    const adapter = createAdapter();
    await adapter.send("/handoff back").assertReply((reply) => {
      expect(reply.text).toContain("Handed back");
    });
  });

  it("handles /handoff back when no active handoff", async () => {
    sessionState.handoffMode = undefined;

    const adapter = createAdapter();
    await adapter.send("/handoff back").assertReply((reply) => {
      expect(reply.text).toContain("No active handoff");
    });
  });
});
