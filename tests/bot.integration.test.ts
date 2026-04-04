import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Mock SDK ----
const mockQuery = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => mockQuery(args),
  listSessions: vi.fn().mockResolvedValue([]),
  getSessionMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/handoff/store.js", () => ({
  saveConversationId: vi.fn(),
  getConversationId: vi.fn(() => "conv-1"),
}));

// State mock — in-memory preferences
const stateValues = {
  sessionId: undefined as string | undefined,
  workDir: "/work/test",
  model: "claude-opus-4-6" as string | undefined,
  thinkingTokens: 2048 as number | null | undefined,
  permissionMode: "bypassPermissions",
  handoffMode: undefined as "pickup" | undefined,
  managed: null as unknown,
};

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
    setWorkDir: vi.fn((dir: string) => {
      stateValues.workDir = dir;
      return { ok: true } as const;
    }),
    getModel: vi.fn(() => stateValues.model),
    setModel: vi.fn((model: string) => {
      stateValues.model = model;
    }),
    getThinkingTokens: vi.fn(() => stateValues.thinkingTokens),
    setThinkingTokens: vi.fn((tokens: number | null) => {
      stateValues.thinkingTokens = tokens;
    }),
    getPermissionMode: vi.fn(() => stateValues.permissionMode),
    setPermissionMode: vi.fn((mode: string) => {
      stateValues.permissionMode = mode;
    }),
    getHandoffMode: vi.fn(() => stateValues.handoffMode),
    setHandoffMode: vi.fn((m: "pickup") => {
      stateValues.handoffMode = m;
    }),
    clearHandoffMode: vi.fn(() => {
      stateValues.handoffMode = undefined;
    }),
    getCachedCommands: vi.fn(() => undefined),
    setCachedCommands: vi.fn(),
    addUsage: vi.fn(),
    getUsageStats: vi.fn(() => ({
      turns: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    })),
    setSessionTitle: vi.fn(),
    getBotTitle: vi.fn(() => undefined),
    loadPersistedState: vi.fn(),
  };
});

import * as state from "../src/session/state.js";
import { registerMessageHandler } from "../src/bot/message.js";
import { handleCardAction, interactiveCards } from "../src/bot/cards.js";
import {
  createStreamingProgress,
  createProactiveProgress,
} from "../src/bot/bridge.js";
import type { App } from "@microsoft/teams.apps";
import type { IMessageActivity, IActivityContext } from "@microsoft/teams.apps";

// ─── Mock App + test harness ─────────────────────────────────────────────

type HandlerFn = (ctx: IActivityContext<IMessageActivity>) => Promise<void>;

interface MockApp {
  app: App;
  handlers: Map<string, HandlerFn>;
  sentActivities: Array<{ conversationId: string; activity: unknown }>;
  /** Invoke the captured handler for a given route with a mock context. */
  invoke: (
    route: string,
    activity: Partial<IMessageActivity>,
  ) => Promise<{
    sent: unknown[];
    stream: {
      emit: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
  }>;
}

function createMockApp(): MockApp {
  const handlers = new Map<string, HandlerFn>();
  const sentActivities: MockApp["sentActivities"] = [];

  const app = {
    on: vi.fn((route: string, handler: HandlerFn) => {
      handlers.set(route, handler);
    }),
    send: vi.fn(async (conversationId: string, activity: unknown) => {
      sentActivities.push({ conversationId, activity });
      return { id: `sent-${sentActivities.length}` };
    }),
    api: {
      conversations: {
        activities: vi.fn((_convId: string) => ({
          delete: vi.fn(async () => {}),
          update: vi.fn(async () => {}),
        })),
      },
    },
  } as unknown as App;

  const invoke = async (
    route: string,
    activity: Partial<IMessageActivity>,
  ): Promise<{
    sent: unknown[];
    stream: {
      emit: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
  }> => {
    const handler = handlers.get(route);
    if (!handler) throw new Error(`No handler registered for route: ${route}`);

    const sent: unknown[] = [];
    const stream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() };
    const ctx = {
      activity: {
        type: "message",
        channelId: "msteams",
        from: { id: "user-1", name: "Test User", aadObjectId: "aad-1" },
        recipient: { id: "bot" },
        conversation: { id: "conv-1" },
        serviceUrl: "https://amer.ng.msg.teams.microsoft.com",
        ...activity,
      },
      ref: {
        conversation: { id: "conv-1" },
      },
      send: vi.fn(async (msg: unknown) => {
        sent.push(msg);
        return { id: `reply-${sent.length}` };
      }),
      stream,
      api: {
        conversations: {
          activities: vi.fn((_convId: string) => ({
            delete: vi.fn(async () => {}),
            update: vi.fn(async () => {}),
          })),
        },
      },
    } as unknown as IActivityContext<IMessageActivity>;

    await handler(ctx);
    return { sent, stream };
  };

  return { app, handlers, sentActivities, invoke };
}

function makeActivity(
  text: string,
  extra?: Partial<IMessageActivity>,
): Partial<IMessageActivity> {
  return {
    id: `activity-${Date.now()}-${Math.random()}`,
    type: "message",
    text,
    channelId: "msteams",
    from: {
      id: "user-1",
      name: "Test User",
      aadObjectId: "aad-1",
    } as IMessageActivity["from"],
    recipient: { id: "bot" } as IMessageActivity["recipient"],
    conversation: { id: "conv-1" } as IMessageActivity["conversation"],
    serviceUrl: "https://amer.ng.msg.teams.microsoft.com",
    ...extra,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("ClaudeCodeBot e2e (Teams SDK)", () => {
  let mock: MockApp;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    stateValues.sessionId = undefined;
    stateValues.workDir = "/work/test";
    stateValues.model = "claude-opus-4-6";
    stateValues.thinkingTokens = 2048;
    stateValues.permissionMode = "bypassPermissions";
    stateValues.handoffMode = undefined;
    stateValues.managed = null;
    interactiveCards.clear();

    mock = createMockApp();
    registerMessageHandler(mock.app);
  });

  it("handles basic message flow", async () => {
    const { sent } = await mock.invoke("message", makeActivity("Hello"));

    // Should send typing indicator then pass to session
    // The first sent item is the typing indicator
    expect(sent.length).toBeGreaterThanOrEqual(1);
    // Typing indicator is a TypingActivity object
    const typing = sent[0];
    expect(typing).toBeDefined();

    // A managed session should have been created and stored
    expect(vi.mocked(state.setSession)).toHaveBeenCalled();
  });

  it("handles /help command with Adaptive Card", async () => {
    const { sent } = await mock.invoke("message", makeActivity("/help"));

    // sent[0] is TypingActivity, command response follows
    const replies = sent.filter(
      (s) => typeof s === "object" && (s as Record<string, unknown>).type !== "typing",
    );
    expect(replies.length).toBeGreaterThanOrEqual(1);
    const reply = replies[0] as {
      attachments?: Array<{ contentType: string; content: unknown }>;
    };
    expect(reply.attachments?.[0].contentType).toBe(
      "application/vnd.microsoft.card.adaptive",
    );
    expect(reply.attachments?.[0].content).toMatchObject({
      type: "AdaptiveCard",
    });

    // mockQuery should NOT have been called — command handled locally
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("handles /status command", async () => {
    stateValues.managed = {
      session: {
        currentSessionId: "sess-abcdef123456",
        hasQuery: true,
        lastActivityTime: Date.now(),
        getSupportedCommands: vi.fn().mockResolvedValue(undefined),
      },
    };
    stateValues.workDir = "/work/demo";
    stateValues.model = "claude-sonnet-4-6";
    stateValues.thinkingTokens = 4096;
    stateValues.permissionMode = "default";

    const { sent } = await mock.invoke("message", makeActivity("/status"));

    const texts = sent.filter((s) => typeof s === "string");
    expect(texts.length).toBeGreaterThanOrEqual(1);
    const text = texts[0] as string;
    expect(text).toContain("**Session:**");
    expect(text).toContain("sess-abcdef1");
    expect(text).toContain("**Work dir:** `/work/demo`");
    expect(text).toContain("**Model:** `claude-sonnet-4-6`");
    expect(text).toContain("**Thinking:** `4096` tokens");
    expect(text).toContain("**Permission:** `default`");
  });

  it("handles /new command", async () => {
    const { sent } = await mock.invoke("message", makeActivity("/new"));

    const texts = sent.filter((s) => typeof s === "string");
    const text = texts[0] as string;
    expect(text).toBe("New session. Send your next message.");

    expect(vi.mocked(state.destroySession)).toHaveBeenCalled();
    expect(vi.mocked(state.clearPersistedSessionId)).toHaveBeenCalled();
  });

  it("rejects unauthorized users when allowedUsers is set", async () => {
    // Temporarily set allowedUsers
    const { config } = await import("../src/config.js");
    const origAllowedUsers = config.allowedUsers;
    config.allowedUsers = new Set(["other-user-id"]);

    try {
      const { sent } = await mock.invoke(
        "message",
        makeActivity("Hello", {
          from: {
            id: "unauth",
            name: "Hacker",
            aadObjectId: "not-allowed",
          } as IMessageActivity["from"],
        }),
      );

      const texts = sent.map((s) => (typeof s === "string" ? s : ""));
      expect(texts.some((t) => t.includes("not authorized"))).toBe(true);
    } finally {
      config.allowedUsers = origAllowedUsers;
    }
  });

  it("ignores empty messages", async () => {
    const { sent } = await mock.invoke(
      "message",
      makeActivity("", { id: `empty-${Date.now()}` }),
    );

    // No card action, no text, no attachments — should be ignored
    // The message handler returns early without sending anything
    expect(sent.length).toBe(0);
  });

  it("sends informative typing indicator for regular messages", async () => {
    const { sent } = await mock.invoke("message", makeActivity("Hello there"));

    // First sent item should be a typing activity
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const typing = sent[0] as Record<string, unknown>;
    expect(typing).toBeDefined();
    // The TypingActivity constructor creates a typing object
  });

  it("registers install.add handler", () => {
    expect(mock.handlers.has("install.add")).toBe(true);
  });
});

describe("permission card interactions", () => {
  let mock: MockApp;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    stateValues.sessionId = undefined;
    stateValues.permissionMode = "bypassPermissions";
    stateValues.managed = null;
    interactiveCards.clear();

    mock = createMockApp();
    registerMessageHandler(mock.app);
  });

  it("handles /permission command with card", async () => {
    const { sent } = await mock.invoke("message", makeActivity("/permission"));

    const replies = sent.filter(
      (s) => typeof s === "object" && (s as Record<string, unknown>).type !== "typing",
    );
    expect(replies.length).toBeGreaterThanOrEqual(1);
    const reply = replies[0] as {
      attachments?: Array<{
        contentType: string;
        content: Record<string, unknown>;
      }>;
    };
    expect(reply.attachments).toBeDefined();
    expect(reply.attachments?.length).toBe(1);
    const card = reply.attachments![0].content;
    expect(card.type).toBe("AdaptiveCard");
    const actions = card.actions as Array<Record<string, unknown>>;
    // Current mode (bypassPermissions) is excluded from actions
    expect(actions.length).toBe(5);
    const modeIds = actions.map((a) => (a.data as { mode: string }).mode);
    expect(modeIds).not.toContain("bypassPermissions");
    expect(modeIds).toEqual(
      expect.arrayContaining([
        "default",
        "auto",
        "acceptEdits",
        "plan",
        "dontAsk",
      ]),
    );
  });

  it("handles /permission plan", async () => {
    const { sent } = await mock.invoke(
      "message",
      makeActivity("/permission plan"),
    );

    const texts = sent.map((s) => (typeof s === "string" ? s : ""));
    expect(texts).toContain("Permission mode set to `plan`");
  });

  it("handles /permission dontAsk", async () => {
    const { sent } = await mock.invoke(
      "message",
      makeActivity("/permission dontAsk"),
    );

    const texts = sent.map((s) => (typeof s === "string" ? s : ""));
    expect(texts).toContain("Permission mode set to `dontAsk`");
  });

  it("handles set_permission_mode card action", async () => {
    const sendFn = vi.fn();
    await handleCardAction(
      { action: "set_permission_mode", mode: "acceptEdits" },
      sendFn,
    );

    expect(sendFn).toHaveBeenCalledWith(expect.stringContaining("acceptEdits"));
  });

  it("handles permission_allow action for unknown toolUseID", async () => {
    const sendFn = vi.fn();
    // Unknown toolUseID: no cardInfo, no crash
    await handleCardAction(
      { action: "permission_allow", toolUseID: "nonexistent-123" },
      sendFn,
    );
    // Should not throw
  });

  it("handles permission_deny action for unknown toolUseID", async () => {
    const sendFn = vi.fn();
    await handleCardAction(
      { action: "permission_deny", toolUseID: "nonexistent-456" },
      sendFn,
    );
    // Should not throw
  });

  it("handles permission_decision action with allow choice", async () => {
    const sendFn = vi.fn();
    await handleCardAction(
      {
        action: "permission_decision",
        toolUseID: "nonexistent-decision-1",
        permissionChoice: "allow",
      },
      sendFn,
    );
    // Should not throw
  });

  it("handles permission_decision action with deny choice", async () => {
    const sendFn = vi.fn();
    await handleCardAction(
      {
        action: "permission_decision",
        toolUseID: "nonexistent-decision-2",
        permissionChoice: "deny",
      },
      sendFn,
    );
  });

  it("handles permission_decision action with suggestion choice", async () => {
    const sendFn = vi.fn();
    await handleCardAction(
      {
        action: "permission_decision",
        toolUseID: "nonexistent-decision-3",
        permissionChoice: "suggestion_0",
      },
      sendFn,
    );
  });
});

describe("user input (PromptRequest) flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateValues.managed = null;
    interactiveCards.clear();
  });

  it("handles prompt_response action for expired request", async () => {
    const sendFn = vi.fn();
    await handleCardAction(
      {
        action: "prompt_response",
        requestId: "nonexistent-prompt",
        key: "yes",
      },
      sendFn,
    );

    expect(sendFn).toHaveBeenCalledWith(expect.stringContaining("expired"));
  });

  it("handles prompt_response with valid pending request", async () => {
    const { registerPromptRequest } =
      await import("../src/claude/user-input.js");

    const promptPromise = registerPromptRequest("test-prompt-123", {
      timeoutMs: 5000,
    });

    const sendFn = vi.fn();
    await handleCardAction(
      {
        action: "prompt_response",
        requestId: "test-prompt-123",
        key: "confirm",
      },
      sendFn,
    );

    expect(sendFn).toHaveBeenCalledWith(expect.stringContaining("confirm"));

    const result = await promptPromise;
    expect(result).toBe("confirm");
  });
});

describe("session resume failure recovery", () => {
  let mock: MockApp;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    stateValues.sessionId = "stale-session";
    stateValues.workDir = "/work/test";
    stateValues.managed = null;
    interactiveCards.clear();

    mock = createMockApp();
    registerMessageHandler(mock.app);
  });

  it("creates managed session that will attempt resume", async () => {
    // When there's a persisted sessionId, createManagedSession should use it
    await mock.invoke("message", makeActivity("Hello"));

    // A session should have been created
    expect(vi.mocked(state.setSession)).toHaveBeenCalled();
  });
});

describe("streaming progress via stream.emit", () => {
  it("text events emit delta text directly via stream.emit", () => {
    const stream = { emit: vi.fn() };
    const sendFn = vi.fn(async () => ({ id: "msg-1" }));

    const progress = createStreamingProgress(stream, sendFn);

    // Text events now carry deltas directly (not accumulated)
    progress.onProgress({ type: "text", text: "Hello" });
    expect(stream.emit).toHaveBeenCalledWith("Hello");

    progress.onProgress({ type: "text", text: " world" });
    expect(stream.emit).toHaveBeenCalledWith(" world");
  });

  it("tool_use events emit formatted tool message", () => {
    const stream = { emit: vi.fn() };
    const sendFn = vi.fn(async () => ({ id: "msg-1" }));

    const progress = createStreamingProgress(stream, sendFn);

    progress.onProgress({
      type: "tool_use",
      tool: { name: "Bash", command: "ls -la" },
    });

    expect(stream.emit).toHaveBeenCalledWith(
      expect.stringContaining("Running: ls -la"),
    );
  });

  it("file_diff events emit file path and patch", () => {
    const stream = { emit: vi.fn() };
    const sendFn = vi.fn(async () => ({ id: "msg-1" }));

    const progress = createStreamingProgress(stream, sendFn);

    progress.onProgress({
      type: "file_diff",
      filePath: "/work/test/src/index.ts",
      patch: "@@ -1 +1 @@\n-old\n+new",
    });

    expect(stream.emit).toHaveBeenCalledWith(
      expect.stringContaining("src/index.ts"),
    );
    expect(stream.emit).toHaveBeenCalledWith(
      expect.stringContaining("```typescript"),
    );
    expect(stream.emit).toHaveBeenCalledWith(expect.stringContaining("-old"));
  });

  it("file_diff without patch emits short label", () => {
    const stream = { emit: vi.fn() };
    const sendFn = vi.fn(async () => ({ id: "msg-1" }));

    const progress = createStreamingProgress(stream, sendFn);

    progress.onProgress({
      type: "file_diff",
      filePath: "/work/test/src/app.ts",
    });

    expect(stream.emit).toHaveBeenCalledWith(
      expect.stringContaining("Edited src/app.ts"),
    );
  });

  it("todo events emit formatted task list", () => {
    const stream = { emit: vi.fn() };
    const sendFn = vi.fn(async () => ({ id: "msg-1" }));

    const progress = createStreamingProgress(stream, sendFn);

    progress.onProgress({
      type: "todo",
      todos: [
        { content: "Step 1", status: "completed" },
        { content: "Step 2", status: "in_progress" },
        { content: "Step 3", status: "pending" },
      ],
    });

    const emitted = stream.emit.mock.calls.map((c: unknown[]) => c[0]).join("");
    expect(emitted).toContain("1/3");
    expect(emitted).toContain("Step 1");
    expect(emitted).toContain("Step 2");
    expect(emitted).toContain("Step 3");
  });

  it("done event captures promptSuggestion without emitting", () => {
    const stream = { emit: vi.fn() };
    const sendFn = vi.fn(async () => ({ id: "msg-1" }));

    const progress = createStreamingProgress(stream, sendFn);

    progress.onProgress({
      type: "done",
      promptSuggestion: "Run tests next?",
    });

    expect(progress.getPromptSuggestion()).toBe("Run tests next?");
    expect(stream.emit).not.toHaveBeenCalled();
  });

  it("finalize sends extra chunks via sendFn (skips first when stream emitted)", async () => {
    const stream = { emit: vi.fn() };
    const sendFn = vi.fn(async () => ({ id: "msg-1" }));

    const progress = createStreamingProgress(stream, sendFn);

    // Simulate some streaming output so hasEmitted = true
    progress.onProgress({ type: "text", text: "Hello" });

    await progress.finalize(["First chunk", "Second chunk", "Third chunk"]);

    // First chunk is part of the stream — only extra chunks are sent
    expect(sendFn).toHaveBeenCalledTimes(2);
  });

  it("finalize sends all chunks when nothing was streamed (error path)", async () => {
    const stream = { emit: vi.fn() };
    const sendFn = vi.fn(async () => ({ id: "msg-1" }));

    const progress = createStreamingProgress(stream, sendFn);

    // No progress events — error path
    await progress.finalize(["Error message"]);

    // Nothing was streamed, so finalize must send all chunks
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it("finalize with single chunk does not call sendFn when stream emitted", async () => {
    const stream = { emit: vi.fn() };
    const sendFn = vi.fn(async () => ({ id: "msg-1" }));

    const progress = createStreamingProgress(stream, sendFn);

    progress.onProgress({ type: "text", text: "Some output" });

    await progress.finalize(["Only chunk"]);

    expect(sendFn).not.toHaveBeenCalled();
  });

  it("tool_result emits result text", () => {
    const stream = { emit: vi.fn() };
    const sendFn = vi.fn(async () => ({ id: "msg-1" }));

    const progress = createStreamingProgress(stream, sendFn);

    progress.onProgress({ type: "tool_result", result: "command output here" });

    expect(stream.emit).toHaveBeenCalledWith(
      expect.stringContaining("command output here"),
    );
  });

  it("auth_error emits login message", () => {
    const stream = { emit: vi.fn() };
    const sendFn = vi.fn(async () => ({ id: "msg-1" }));

    const progress = createStreamingProgress(stream, sendFn);

    progress.onProgress({ type: "auth_error" });

    expect(stream.emit).toHaveBeenCalledWith(
      expect.stringContaining("Login expired"),
    );
  });

  it("rate_limit rejected emits warning", () => {
    const stream = { emit: vi.fn() };
    const sendFn = vi.fn(async () => ({ id: "msg-1" }));

    const progress = createStreamingProgress(stream, sendFn);

    progress.onProgress({ type: "rate_limit", status: "rejected" });

    expect(stream.emit).toHaveBeenCalledWith(
      expect.stringContaining("Rate limited"),
    );
  });

  it("text segment resets on non-text event", () => {
    const stream = { emit: vi.fn() };
    const sendFn = vi.fn(async () => ({ id: "msg-1" }));

    const progress = createStreamingProgress(stream, sendFn);

    // Delta text
    progress.onProgress({ type: "text", text: "Hello" });
    progress.onProgress({ type: "text", text: " world" });
    expect(stream.emit).toHaveBeenCalledWith(" world");

    // Tool use breaks the text segment
    progress.onProgress({
      type: "tool_use",
      tool: { name: "Bash", command: "ls" },
    });

    // New text after tool use — full text emitted (not delta from old segment)
    stream.emit.mockClear();
    progress.onProgress({ type: "text", text: "After tool" });
    expect(stream.emit).toHaveBeenCalledWith("After tool");
  });
});

describe("proactive progress (handoff context)", () => {
  it("ignores all progress events except done", () => {
    const sendFn = vi.fn(async () => ({ id: "msg-1" }));

    const progress = createProactiveProgress(sendFn);

    progress.onProgress({ type: "text", text: "Hello" });
    progress.onProgress({
      type: "tool_use",
      tool: { name: "Bash", command: "ls" },
    });
    progress.onProgress({
      type: "file_diff",
      filePath: "src/index.ts",
      patch: "diff",
    });

    expect(sendFn).not.toHaveBeenCalled();
  });

  it("done event captures promptSuggestion", () => {
    const sendFn = vi.fn(async () => ({ id: "msg-1" }));

    const progress = createProactiveProgress(sendFn);

    progress.onProgress({
      type: "done",
      promptSuggestion: "What next?",
    });

    expect(progress.getPromptSuggestion()).toBe("What next?");
  });

  it("finalize sends each chunk as a new message", async () => {
    const sendFn = vi.fn(async () => ({ id: "msg-1" }));

    const progress = createProactiveProgress(sendFn);

    await progress.finalize(["Chunk 1", "Chunk 2", "Chunk 3"]);

    expect(sendFn).toHaveBeenCalledTimes(3);
  });

  it("finalize with empty chunks does nothing", async () => {
    const sendFn = vi.fn(async () => ({ id: "msg-1" }));

    const progress = createProactiveProgress(sendFn);

    await progress.finalize([]);

    expect(sendFn).not.toHaveBeenCalled();
  });
});

describe("handoff flow", () => {
  let mock: MockApp;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    stateValues.sessionId = undefined;
    stateValues.managed = null;
    stateValues.handoffMode = undefined;
    interactiveCards.clear();

    mock = createMockApp();
    registerMessageHandler(mock.app);
  });

  it("handles /handoff back command", async () => {
    stateValues.handoffMode = "pickup";

    const { sent } = await mock.invoke(
      "message",
      makeActivity("/handoff back"),
    );

    const texts = sent.map((s) => (typeof s === "string" ? s : ""));
    expect(texts.some((t) => t.includes("Handed back"))).toBe(true);
  });

  it("handles /handoff back when no active handoff", async () => {
    stateValues.handoffMode = undefined;

    const { sent } = await mock.invoke(
      "message",
      makeActivity("/handoff back"),
    );

    const texts = sent.map((s) => (typeof s === "string" ? s : ""));
    expect(texts.some((t) => t.includes("No active handoff"))).toBe(true);
  });
});
