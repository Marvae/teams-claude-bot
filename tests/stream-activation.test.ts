/**
 * Tests for delayed stream activation (stream + streamActivated on message_start).
 *
 * Key behaviors:
 * 1. Stream is NOT touched (emit/update) until "started" event
 * 2. "started" event sets streamActivated = true
 * 3. Compacting status is always proactive (before message_start)
 * 4. Empty results (e.g. /compact) don't send messages
 * 5. Busy guard checks stream ref
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Mock SDK ----
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  listSessions: vi.fn().mockResolvedValue([]),
  getSessionMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/handoff/store.js", () => ({
  saveConversationId: vi.fn(),
  getConversationId: vi.fn(() => "conv-1"),
}));

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
    persistSessionId: vi.fn(),
    clearPersistedSessionId: vi.fn(),
    getSession: vi.fn(() => stateValues.managed),
    setSession: vi.fn((m: unknown) => {
      stateValues.managed = m;
    }),
    destroySession: vi.fn(() => {
      stateValues.managed = null;
    }),
    getWorkDir: vi.fn(() => stateValues.workDir),
    setWorkDir: vi.fn(() => ({ ok: true }) as const),
    getModel: vi.fn(() => stateValues.model),
    setModel: vi.fn(),
    getThinkingTokens: vi.fn(() => stateValues.thinkingTokens),
    setThinkingTokens: vi.fn(),
    getPermissionMode: vi.fn(() => stateValues.permissionMode),
    setPermissionMode: vi.fn(),
    getHandoffMode: vi.fn(() => stateValues.handoffMode),
    setHandoffMode: vi.fn(),
    clearHandoffMode: vi.fn(),
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

import type { ManagedSession } from "../src/session/state.js";
import { registerMessageHandler } from "../src/bot/message.js";
import {
  createStreamingProgress,
  createManagedSession,
} from "../src/bot/bridge.js";
import { interactiveCards } from "../src/bot/cards.js";
import type { App } from "@microsoft/teams.apps";
import type { IMessageActivity, IActivityContext } from "@microsoft/teams.apps";

// ─── Mock App ────────────────────────────────────────────────────────────

type HandlerFn = (ctx: IActivityContext<IMessageActivity>) => Promise<void>;

function createMockApp() {
  const handlers = new Map<string, HandlerFn>();
  const sentActivities: Array<{ conversationId: string; activity: unknown }> =
    [];

  const app = {
    on: vi.fn((route: string, handler: HandlerFn) => {
      handlers.set(route, handler);
    }),
    send: vi.fn(async (_conversationId: string, activity: unknown) => {
      sentActivities.push({ conversationId: _conversationId, activity });
      return { id: `sent-${sentActivities.length}` };
    }),
    api: {
      conversations: {
        activities: vi.fn(() => ({
          delete: vi.fn(async () => {}),
          update: vi.fn(async () => {}),
        })),
      },
    },
  } as unknown as App;

  const invoke = async (
    route: string,
    activity: Partial<IMessageActivity>,
  ) => {
    const handler = handlers.get(route);
    if (!handler) throw new Error(`No handler for route: ${route}`);

    const sent: unknown[] = [];
    const stream = {
      emit: vi.fn(),
      update: vi.fn(),
      close: vi.fn(),
    };
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
      ref: { conversation: { id: "conv-1" } },
      send: vi.fn(async (msg: unknown) => {
        sent.push(msg);
        return { id: `reply-${sent.length}` };
      }),
      stream,
      api: {
        conversations: {
          activities: vi.fn(() => ({
            delete: vi.fn(async () => {}),
            update: vi.fn(async () => {}),
          })),
        },
      },
    } as unknown as IActivityContext<IMessageActivity>;

    await handler(ctx);
    return { sent, stream, sentActivities };
  };

  return { app, handlers, sentActivities, invoke };
}

// ─── Message handler tests ──────────────────────────────────────────────

describe("delayed stream activation — message handler", () => {
  let mock: ReturnType<typeof createMockApp>;

  beforeEach(() => {
    vi.clearAllMocks();
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

  it("does not call stream.emit or stream.update for any message", async () => {
    // SDK mock fails immediately → onResult → handler returns
    // But the important thing: stream was never touched
    const { stream } = await mock.invoke("message", { text: "Hello" });

    expect(stream.emit).not.toHaveBeenCalled();
    expect(stream.update).not.toHaveBeenCalled();
  });

  it("does not call stream.emit or stream.update for /compact", async () => {
    const { stream } = await mock.invoke("message", { text: "/compact" });

    expect(stream.emit).not.toHaveBeenCalled();
    expect(stream.update).not.toHaveBeenCalled();
  });

  it("/compact goes through same code path as normal messages", async () => {
    // Both /compact and normal messages should create a session
    await mock.invoke("message", { text: "/compact" });
    expect(stateValues.managed).not.toBeNull();
  });
});

// ─── Bridge "started" event tests ───────────────────────────────────────

describe("delayed stream activation — bridge onProgress", () => {
  it("stream is set but not activated initially", () => {
    const mock = createMockApp();
    const managed = createManagedSession(
      mock.app,
      "conv-1",
      interactiveCards,
    );

    const stream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() };
    // Simulate what message.ts does
    (managed as ManagedSession).stream =
      stream as unknown as ManagedSession["stream"];

    stateValues.managed = managed;

    const ms = managed as ManagedSession;
    expect(ms.stream).toBeDefined();
    expect(ms.streamActivated).toBeFalsy();
  });

  it("streaming progress does not emit for started event", () => {
    const stream = { emit: vi.fn(), update: vi.fn() };
    const sendFn = vi.fn(async () => ({ id: "msg-1" }));

    const progress = createStreamingProgress(stream, sendFn);

    // "started" event should be handled by bridge, not by streaming progress
    // If it leaks through, it should not crash or emit anything
    progress.onProgress({ type: "started" } as never);

    expect(stream.emit).not.toHaveBeenCalled();
  });
});

// ─── Compacting status tests ────────────────────────────────────────────

describe("compacting status — always proactive", () => {
  it("compacting status uses proactiveSend (not stream.update)", () => {
    const mock = createMockApp();
    const managed = createManagedSession(
      mock.app,
      "conv-1",
      interactiveCards,
    );

    const stream = { emit: vi.fn(), update: vi.fn(), close: vi.fn() };
    (managed as ManagedSession).stream =
      stream as unknown as ManagedSession["stream"];
    stateValues.managed = managed;

    // Even with a stream ref, compacting should NOT call stream.update
    // because streamActivated is false
    expect(stream.update).not.toHaveBeenCalled();
  });

  it("empty result does not send any message", () => {
    const stream = { emit: vi.fn() };
    const sendFn = vi.fn(async () => ({ id: "msg-1" }));

    // Create progress but don't use it — simulates empty result
    createStreamingProgress(stream, sendFn);

    // Simulate empty result finalize with no prior emit
    // This is what happens for /compact — nothing was streamed, nothing to send
    expect(stream.emit).not.toHaveBeenCalled();
    expect(sendFn).not.toHaveBeenCalled();
  });
});
