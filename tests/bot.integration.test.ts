import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TestAdapter,
  TurnContext,
  ActivityTypes,
  type Activity,
} from "botbuilder";

// ---- Mock SDK query to return controlled results ----
const mockQuery = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => mockQuery(args),
  listSessions: vi.fn().mockResolvedValue([]),
  getSessionMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/handoff/store.js", () => ({
  saveConversationRef: vi.fn(),
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
  };
});

import * as state from "../src/session/state.js";
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
  const adapter = new TestAdapter(async (context) => {
    await bot.run(context);
  });
  // Patch continueConversation — TestAdapter doesn't implement it natively.
  // We create a TurnContext that routes sendActivity back to the adapter's reply queue.
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
    // Route replies back through the adapter so assertReply works
    ctx.onSendActivities(async (_ctx, activities, next) => {
      for (const a of activities) {
        // Push to adapter's activeQueue so TestAdapter.assertReply can see it
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
    // Reset state
    stateValues.sessionId = undefined;
    stateValues.workDir = "/work/test";
    stateValues.model = "claude-opus-4-6";
    stateValues.thinkingTokens = 2048;
    stateValues.permissionMode = "bypassPermissions";
    stateValues.handoffMode = undefined;
    stateValues.managed = null;
  });

  it("handles basic message flow", async () => {
    setupMockQuery("Hello from Claude", "sess-123");

    const adapter = createAdapter();

    await adapter
      .send(makeActivity("Hello"))
      .assertReply((activity) => assertInformativeTyping(activity))
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

    expect(vi.mocked(state.persistSessionId)).toHaveBeenCalledWith("sess-123");
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
    // Simulate a live session with currentSessionId
    stateValues.managed = {
      session: {
        currentSessionId: "sess-abcdef123456",
        hasQuery: true,
        lastActivityTime: Date.now(),
        getSupportedCommands: vi.fn().mockResolvedValue(undefined),
      },
      setCtx: vi.fn(),
    };
    stateValues.workDir = "/work/demo";
    stateValues.model = "claude-sonnet-4-6";
    stateValues.thinkingTokens = 4096;
    stateValues.permissionMode = "default";

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

    expect(vi.mocked(state.destroySession)).toHaveBeenCalled();
    expect(vi.mocked(state.clearPersistedSessionId)).toHaveBeenCalled();
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

    expect(vi.mocked(state.persistSessionId)).toHaveBeenCalledWith("sess-old");
  });

  it("resume action stores session cwd alongside sessionId", async () => {
    const adapter = createAdapter();
    const activity = makeActivity("", {
      value: {
        action: "resume_session",
        sessionId: "sess-abc",
        sessionCwds: { "sess-abc": "/work/other-project" },
      },
    });

    await adapter
      .send(activity)
      .assertReply((reply) => {
        expect(reply.text).toContain("Resumed session");
        expect(reply.text).toContain("/work/other-project");
      })
      .startTest();

    expect(vi.mocked(state.persistSessionId)).toHaveBeenCalledWith("sess-abc");
    expect(vi.mocked(state.setWorkDir)).toHaveBeenCalledWith(
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

    expect(vi.mocked(state.persistSessionId)).toHaveBeenCalledWith(
      "sess-no-cwd",
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
    stateValues.sessionId = undefined;
    stateValues.permissionMode = "bypassPermissions";
    stateValues.managed = null;
  });

  it("handles /permission command with card", async () => {
    const adapter = createAdapter();
    await adapter.send("/permission").assertReply((reply) => {
      expect(reply.attachments).toBeDefined();
      expect(reply.attachments?.length).toBe(1);
      const card = reply.attachments![0].content as Record<string, unknown>;
      expect(card.type).toBe("AdaptiveCard");
      const actions = card.actions as Array<Record<string, unknown>>;
      // Current mode (bypassPermissions) is excluded from actions
      expect(actions.length).toBe(4);
      const modeIds = actions.map((a) => (a.data as { mode: string }).mode);
      expect(modeIds).not.toContain("bypassPermissions");
      expect(modeIds).toEqual(
        expect.arrayContaining(["default", "acceptEdits", "plan", "dontAsk"]),
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
      .assertReply((activity) => assertInformativeTyping(activity))
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
      .assertReply((activity) => assertInformativeTyping(activity))
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
    // Unknown toolUseID: no cardInfo, no reply — just silently returns
    await adapter.send({
      type: ActivityTypes.Message,
      value: {
        action: "permission_allow",
        toolUseID: "nonexistent-123",
      },
    });
  });

  it("handles permission_deny action for unknown toolUseID", async () => {
    const adapter = createAdapter();
    // Unknown toolUseID: no cardInfo, no reply — just silently returns
    await adapter.send({
      type: ActivityTypes.Message,
      value: {
        action: "permission_deny",
        toolUseID: "nonexistent-456",
      },
    });
  });
});

describe("user input (PromptRequest) flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateValues.managed = null;
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
        expect(reply.text).toContain("expired");
      });
  });

  it("handles prompt_response with valid pending request", async () => {
    const { registerPromptRequest } =
      await import("../src/claude/user-input.js");

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

    const result = await promptPromise;
    expect(result).toBe("confirm");
  });
});

describe("session resume failure recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    stateValues.sessionId = "stale-session";
    stateValues.workDir = "/work/test";
    stateValues.managed = null;
  });

  it.skip("notifies user and retries with fresh session when resume fails", async () => {
    let callCount = 0;
    mockQuery.mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        // First call: simulate resume failure (session closed with error)
        yield {
          type: "result",
          is_error: true,
          subtype: "error_session",
          errors: ["No conversation found with session ID: stale-session"],
        };
        return;
      }
      // Second call: fresh session succeeds
      yield { type: "system", subtype: "init", session_id: "fresh-sess" };
      yield { type: "result", result: "Hello fresh!" };
    });

    const adapter = createAdapter();

    await adapter
      .send(makeActivity("Hello"))
      .assertReply((activity) => assertInformativeTyping(activity))
      .assertReply((activity) => {
        expect(activity.text).toContain(
          "Previous session could not be resumed",
        );
      })
      .assertReply((activity) => assertInformativeTyping(activity))
      .assertReply((activity) => {
        expect(activity.text).toBe("Hello fresh!");
      })
      .startTest();

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(vi.mocked(state.clearPersistedSessionId)).toHaveBeenCalled();
  });
});

describe("progress notifier streaming via updateActivity", () => {
  it("sends first update as new message, subsequent updates via updateActivity", async () => {
    const bot = new ClaudeCodeBot();
    const sent: Array<{ action: string; activity: Record<string, unknown> }> =
      [];

    const sendFn = vi.fn(async (activity: Record<string, unknown>) => {
      sent.push({ action: "send", activity });
      return { id: "msg-1" };
    });
    const updateFn = vi.fn(
      async (_id: string, activity: Record<string, unknown>) => {
        sent.push({ action: "update", activity });
      },
    );

    const notifier = bot.createProgressNotifier(sendFn, updateFn);

    // First text event — should send a new message
    notifier.onProgress({ type: "text", text: "Hello" });
    await new Promise((r) => setTimeout(r, 50));
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sent[0].action).toBe("send");
    expect(sent[0].activity.type).toBe("message");
    expect(sent[0].activity.text).toBe("Hello");

    // Second text event — should update the same message
    notifier.onProgress({ type: "text", text: "Hello world" });
    // Wait for throttle
    await new Promise((r) => setTimeout(r, 1100));
    expect(updateFn).toHaveBeenCalled();
    const updateCall = sent.find((s) => s.action === "update");
    expect(updateCall?.activity.text).toBe("Hello world");
  });

  it("finalize updates the streaming message with final content", async () => {
    const bot = new ClaudeCodeBot();
    const sent: Array<{
      action: string;
      id?: string;
      activity: Record<string, unknown>;
    }> = [];

    const sendFn = vi.fn(async (activity: Record<string, unknown>) => {
      sent.push({ action: "send", activity });
      return { id: "msg-stream" };
    });
    const updateFn = vi.fn(
      async (id: string, activity: Record<string, unknown>) => {
        sent.push({ action: "update", id, activity });
      },
    );

    const notifier = bot.createProgressNotifier(sendFn, updateFn);

    // Trigger a streaming message
    notifier.onProgress({ type: "text", text: "partial" });
    await new Promise((r) => setTimeout(r, 50));

    // Finalize with final content
    await notifier.finalize(["Final result"]);

    // Should have updated the streaming message, not sent a new one
    const finalUpdate = sent.filter((s) => s.action === "update");
    expect(finalUpdate.length).toBeGreaterThanOrEqual(1);
    const last = finalUpdate[finalUpdate.length - 1];
    expect(last.id).toBe("msg-stream");
    expect(last.activity.text).toBe("Final result");

    // sendFn should only have been called once (for the initial streaming message)
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it("finalize sends new message when no streaming activity exists", async () => {
    const bot = new ClaudeCodeBot();

    const sendFn = vi.fn(async () => ({ id: "msg-new" }));
    const updateFn = vi.fn(async () => {});

    const notifier = bot.createProgressNotifier(sendFn, updateFn);

    // Finalize without any prior streaming
    await notifier.finalize(["Direct result"]);

    expect(sendFn).toHaveBeenCalledWith({
      type: "message",
      text: "Direct result",
    });
    expect(updateFn).not.toHaveBeenCalled();
  });

  it("tool_result appends to streaming text without clearing previous content", async () => {
    const bot = new ClaudeCodeBot();
    const sent: Array<{ action: string; activity: Record<string, unknown> }> =
      [];

    const sendFn = vi.fn(async (activity: Record<string, unknown>) => {
      sent.push({ action: "send", activity });
      return { id: "msg-tr" };
    });
    const updateFn = vi.fn(
      async (_id: string, activity: Record<string, unknown>) => {
        sent.push({ action: "update", activity });
      },
    );

    const notifier = bot.createProgressNotifier(sendFn, updateFn);

    // Claude outputs text
    notifier.onProgress({ type: "text", text: "Let me run that." });
    await new Promise((r) => setTimeout(r, 50));

    // Tool result arrives
    notifier.onProgress({ type: "tool_result", result: "command output here" });
    await new Promise((r) => setTimeout(r, 1100));

    // New text from Claude after tool use
    notifier.onProgress({ type: "text", text: "Done!" });
    await new Promise((r) => setTimeout(r, 1100));

    // The display should contain all three parts
    const lastUpdate = sent.filter((s) => s.action === "update").pop();
    const text = lastUpdate?.activity.text as string;
    expect(text).toContain("Let me run that.");
    expect(text).toContain("command output here");
    expect(text).toContain("Done!");
  });

  it("file_diff is included in streaming text flow", async () => {
    const bot = new ClaudeCodeBot();
    const sent: Array<{ action: string; activity: Record<string, unknown> }> =
      [];

    const sendFn = vi.fn(async (activity: Record<string, unknown>) => {
      sent.push({ action: "send", activity });
      return { id: "msg-fd" };
    });
    const updateFn = vi.fn(
      async (_id: string, activity: Record<string, unknown>) => {
        sent.push({ action: "update", activity });
      },
    );

    const notifier = bot.createProgressNotifier(sendFn, updateFn);

    // Claude outputs text
    notifier.onProgress({ type: "text", text: "Editing file." });
    await new Promise((r) => setTimeout(r, 50));

    // File diff arrives
    notifier.onProgress({
      type: "file_diff",
      filePath: "src/index.ts",
      patch: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;",
    });
    await new Promise((r) => setTimeout(r, 1100));

    // Display should contain the file path
    const lastUpdate = sent.filter((s) => s.action === "update").pop();
    const text = lastUpdate?.activity.text as string;
    expect(text).toContain("src/index.ts");
    expect(text).toContain("Editing file.");
  });

  it("progress lines are preserved in finalize", async () => {
    const bot = new ClaudeCodeBot();
    const sent: Array<{ action: string; activity: Record<string, unknown> }> =
      [];

    const sendFn = vi.fn(async (activity: Record<string, unknown>) => {
      sent.push({ action: "send", activity });
      return { id: "msg-pl" };
    });
    const updateFn = vi.fn(
      async (_id: string, activity: Record<string, unknown>) => {
        sent.push({ action: "update", activity });
      },
    );

    const notifier = bot.createProgressNotifier(sendFn, updateFn);

    // Tool use progress
    notifier.onProgress({
      type: "tool_use",
      tool: { name: "Bash", args: "ls" },
    });
    await new Promise((r) => setTimeout(r, 50));

    // Finalize with result
    await notifier.finalize(["All done."]);

    const lastUpdate = sent.filter((s) => s.action === "update").pop();
    const text = lastUpdate?.activity.text as string;
    expect(text).toContain("bash");
    expect(text).toContain("All done.");
  });

  it("completedText is prepended in finalize", async () => {
    const bot = new ClaudeCodeBot();
    const sent: Array<{ action: string; activity: Record<string, unknown> }> =
      [];

    const sendFn = vi.fn(async (activity: Record<string, unknown>) => {
      sent.push({ action: "send", activity });
      return { id: "msg-ct" };
    });
    const updateFn = vi.fn(
      async (_id: string, activity: Record<string, unknown>) => {
        sent.push({ action: "update", activity });
      },
    );

    const notifier = bot.createProgressNotifier(sendFn, updateFn);

    // First turn text
    notifier.onProgress({ type: "text", text: "Checking..." });
    await new Promise((r) => setTimeout(r, 50));

    // Tool result freezes text
    notifier.onProgress({ type: "tool_result", result: "OK" });
    await new Promise((r) => setTimeout(r, 50));

    // Finalize with final text
    await notifier.finalize(["Summary."]);

    const lastUpdate = sent.filter((s) => s.action === "update").pop();
    const text = lastUpdate?.activity.text as string;
    expect(text).toContain("Checking...");
    expect(text).toContain("OK");
    expect(text).toContain("Summary.");
  });

  it("todo update freezes streaming text and preserves it", async () => {
    const bot = new ClaudeCodeBot();
    const sent: Array<{ action: string; activity: Record<string, unknown> }> =
      [];

    const sendFn = vi.fn(async (activity: Record<string, unknown>) => {
      sent.push({ action: "send", activity });
      return { id: "msg-todo" };
    });
    const updateFn = vi.fn(
      async (_id: string, activity: Record<string, unknown>) => {
        sent.push({ action: "update", activity });
      },
    );

    const notifier = bot.createProgressNotifier(sendFn, updateFn);

    // Claude outputs text
    notifier.onProgress({ type: "text", text: "Working on task 1." });
    await new Promise((r) => setTimeout(r, 50));

    // Todo update arrives — should freeze streaming text
    notifier.onProgress({
      type: "todo",
      todos: [
        { content: "Task 1", status: "completed" },
        { content: "Task 2", status: "in_progress" },
      ],
    });
    await new Promise((r) => setTimeout(r, 2100));

    // New text from Claude
    notifier.onProgress({ type: "text", text: "Working on task 2." });
    await new Promise((r) => setTimeout(r, 1100));

    // Display should contain both texts and todo
    const lastUpdate = sent.filter((s) => s.action === "update").pop();
    const text = lastUpdate?.activity.text as string;
    expect(text).toContain("Working on task 1.");
    expect(text).toContain("Working on task 2.");
    expect(text).toContain("Task 1");
    expect(text).toContain("Task 2");
  });

  it("todo display is preserved in finalize", async () => {
    const bot = new ClaudeCodeBot();
    const sent: Array<{ action: string; activity: Record<string, unknown> }> =
      [];

    const sendFn = vi.fn(async (activity: Record<string, unknown>) => {
      sent.push({ action: "send", activity });
      return { id: "msg-todo-fin" };
    });
    const updateFn = vi.fn(
      async (_id: string, activity: Record<string, unknown>) => {
        sent.push({ action: "update", activity });
      },
    );

    const notifier = bot.createProgressNotifier(sendFn, updateFn);

    // Todo event
    notifier.onProgress({
      type: "todo",
      todos: [
        { content: "Step 1", status: "completed" },
        { content: "Step 2", status: "completed" },
      ],
    });
    await new Promise((r) => setTimeout(r, 50));

    // Finalize
    await notifier.finalize(["All tasks done."]);

    const lastUpdate = sent.filter((s) => s.action === "update").pop();
    const text = lastUpdate?.activity.text as string;
    expect(text).toContain("Step 1");
    expect(text).toContain("Step 2");
    expect(text).toContain("All tasks done.");
  });

  it("tool_use progress appears in streaming text flow", async () => {
    const bot = new ClaudeCodeBot();
    const sent: Array<{ action: string; activity: Record<string, unknown> }> =
      [];

    const sendFn = vi.fn(async (activity: Record<string, unknown>) => {
      sent.push({ action: "send", activity });
      return { id: "msg-tu" };
    });
    const updateFn = vi.fn(
      async (_id: string, activity: Record<string, unknown>) => {
        sent.push({ action: "update", activity });
      },
    );

    const notifier = bot.createProgressNotifier(sendFn, updateFn);

    // Claude outputs text
    notifier.onProgress({ type: "text", text: "Let me check." });
    await new Promise((r) => setTimeout(r, 50));

    // Tool use event
    notifier.onProgress({
      type: "tool_use",
      tool: { name: "Read", file: "src/app.ts" },
    });
    await new Promise((r) => setTimeout(r, 2100));

    // New text from Claude
    notifier.onProgress({ type: "text", text: "Found the issue." });
    await new Promise((r) => setTimeout(r, 1100));

    const lastUpdate = sent.filter((s) => s.action === "update").pop();
    const text = lastUpdate?.activity.text as string;
    expect(text).toContain("Let me check.");
    expect(text).toContain("src/app.ts");
    expect(text).toContain("Found the issue.");
  });

  it("non-continuation text segment commits previous streaming text", async () => {
    const bot = new ClaudeCodeBot();
    const sent: Array<{ action: string; activity: Record<string, unknown> }> =
      [];

    const sendFn = vi.fn(async (activity: Record<string, unknown>) => {
      sent.push({ action: "send", activity });
      return { id: "msg-nc" };
    });
    const updateFn = vi.fn(
      async (_id: string, activity: Record<string, unknown>) => {
        sent.push({ action: "update", activity });
      },
    );

    const notifier = bot.createProgressNotifier(sendFn, updateFn);

    // First streaming segment (simulates turnStreamingText accumulation)
    notifier.onProgress({ type: "text", text: "Let me look at the code." });
    await new Promise((r) => setTimeout(r, 50));

    // Second streaming segment — NOT a continuation of the first
    // (simulates turnStreamingText reset + new accumulation)
    notifier.onProgress({ type: "text", text: "OK, now fixing it." });
    await new Promise((r) => setTimeout(r, 1100));

    // Check that the streaming display includes BOTH text segments
    const lastUpdate = sent.filter((s) => s.action === "update").pop();
    const text = lastUpdate?.activity.text as string;
    expect(text).toContain("Let me look at the code.");
    expect(text).toContain("OK, now fixing it.");
  });
});

describe("handoff flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    stateValues.sessionId = undefined;
    stateValues.managed = null;
  });

  it("handles /handoff back command", async () => {
    stateValues.handoffMode = "pickup";

    const adapter = createAdapter();
    await adapter.send("/handoff back").assertReply((reply) => {
      expect(reply.text).toContain("Handed back");
    });
  });

  it("handles /handoff back when no active handoff", async () => {
    stateValues.handoffMode = undefined;

    const adapter = createAdapter();
    await adapter.send("/handoff back").assertReply((reply) => {
      expect(reply.text).toContain("No active handoff");
    });
  });
});
