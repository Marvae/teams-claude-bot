import { describe, it, expect, vi, beforeEach } from "vitest";
import { TestAdapter, ActivityTypes, type Activity } from "botbuilder";

const runClaudeMock = vi.fn();

const sessionState = {
  sessionId: undefined as string | undefined,
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
  setSession: vi.fn((_conversationId: string, sessionId: string) => {
    sessionState.sessionId = sessionId;
  }),
  clearSession: vi.fn(() => {
    sessionState.sessionId = undefined;
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

describe("ClaudeCodeBot e2e (TestAdapter)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runClaudeMock.mockReset();
    sessionState.sessionId = undefined;
    sessionState.workDir = "/work/test";
    sessionState.model = "claude-opus-4-6";
    sessionState.thinkingTokens = 2048;
    sessionState.permissionMode = "bypassPermissions";
    sessionState.pastSessions = [];
    sessionState.switchResult = null;
    sessionState.handoffMode = undefined;
  });

  it("handles basic message flow", async () => {
    runClaudeMock.mockResolvedValue({
      result: "Hello from Claude",
      sessionId: "sess-123",
      tools: [],
    });

    const adapter = createAdapter();

    await adapter
      .send(makeActivity("Hello"))
      .assertReply({ type: ActivityTypes.Typing })
      .assertReply((activity) => {
        expect(activity.type).toBe(ActivityTypes.Message);
        expect(activity.text).toBe("Hello from Claude");
      })
      .startTest();

    expect(runClaudeMock).toHaveBeenCalledOnce();
    expect(runClaudeMock).toHaveBeenCalledWith(
      "Hello",
      undefined,
      "/work/test",
      "claude-opus-4-6",
      2048,
      "bypassPermissions",
      undefined,
      expect.any(Function),
    );
    expect(vi.mocked(sessionManager.setSession)).toHaveBeenCalledWith(
      "conv-1",
      "sess-123",
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

    expect(runClaudeMock).not.toHaveBeenCalled();
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
    sessionState.switchResult = {
      index: 2,
      sessionId: "sess-old",
      workDir: "/work/legacy",
      usedAt: new Date().toISOString(),
    };

    const adapter = createAdapter();
    const activity = makeActivity("", {
      value: { action: "resume_session", index: 2 },
    });

    await adapter
      .send(activity)
      .assertReply((reply) => {
        expect(reply.type).toBe(ActivityTypes.Message);
        expect(reply.text).toContain("Resumed session");
        expect(reply.text).toContain("/work/legacy");
      })
      .startTest();

    expect(vi.mocked(sessionManager.switchToSession)).toHaveBeenCalledWith(
      "conv-1",
      2,
    );
  });

  it("handles adaptive card resume action when session missing", async () => {
    sessionState.switchResult = null;

    const adapter = createAdapter();
    const activity = makeActivity("", {
      value: { action: "resume_session", index: 0 },
    });

    await adapter.send(activity).assertReply("Session not found.").startTest();

    expect(vi.mocked(sessionManager.switchToSession)).toHaveBeenCalledWith(
      "conv-1",
      0,
    );
  });
});

describe("permission card interactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles /permission command with card", async () => {
    const adapter = createAdapter();
    await adapter.send("/permission").assertReply((reply) => {
      expect(reply.attachments).toBeDefined();
      expect(reply.attachments?.length).toBe(1);
      const card = reply.attachments![0].content as Record<string, unknown>;
      expect(card.type).toBe("AdaptiveCard");
      const actions = card.actions as Array<Record<string, unknown>>;
      expect(actions.length).toBe(3);
      expect(actions.map((a) => a.title)).toContain("🛡️ Default");
      expect(actions.map((a) => a.title)).toContain("⚡ Bypass");
    });
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
    runClaudeMock.mockReset();
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
