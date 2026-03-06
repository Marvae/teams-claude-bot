import { describe, it, expect, vi, beforeEach } from "vitest";

const listSessionsMock = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  listSessions: (...args: unknown[]) => listSessionsMock(...args),
}));

const stateValues = {
  managed: null as unknown,
  workDir: "/work/test",
};

vi.mock("../src/session/state.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getSession: vi.fn(() => stateValues.managed),
    setSession: vi.fn(),
    destroySession: vi.fn(),
    loadPersistedSessionId: vi.fn(),
    persistSessionId: vi.fn(),
    clearPersistedSessionId: vi.fn(),
    getWorkDir: vi.fn(() => stateValues.workDir),
    setWorkDir: vi.fn(() => ({ ok: true })),
    getModel: vi.fn(),
    setModel: vi.fn(),
    getThinkingTokens: vi.fn(),
    setThinkingTokens: vi.fn(),
    getPermissionMode: vi.fn(() => "bypassPermissions"),
    setPermissionMode: vi.fn(),
    getHandoffMode: vi.fn(),
    setHandoffMode: vi.fn(),
    clearHandoffMode: vi.fn(),
    getCachedCommands: vi.fn(() => undefined),
    setCachedCommands: vi.fn(),
    getBotTitle: vi.fn(() => undefined),
    setSessionTitle: vi.fn(),
  };
});

import { handleCommand } from "../src/bot/commands.js";
import * as state from "../src/session/state.js";

function makeMockCtx() {
  const sent: unknown[] = [];
  return {
    ctx: {
      sendActivity: vi.fn(async (activity: unknown) => {
        sent.push(activity);
        return { id: "msg-1" };
      }),
    } as unknown as Parameters<typeof handleCommand>[1],
    sent,
  };
}

const NOW = Date.now();

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "aaaa-1111",
    summary: "Test session",
    lastModified: NOW - 60_000,
    fileSize: 1000,
    cwd: "/work/project",
    ...overrides,
  };
}

describe("/sessions command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listSessionsMock.mockReset();
    stateValues.managed = null;
    stateValues.workDir = "/work/test";
    vi.mocked(state.getBotTitle).mockReturnValue(undefined);
  });

  it("shows empty message when no sessions", async () => {
    listSessionsMock.mockResolvedValue([]);
    const { ctx, sent } = makeMockCtx();

    const handled = await handleCommand("/sessions", ctx);

    expect(handled).toBe(true);
    expect(sent[0]).toBe("No sessions. Start chatting to create one.");
  });

  it("shows error message when listSessions throws", async () => {
    listSessionsMock.mockRejectedValue(new Error("SDK error"));
    const { ctx, sent } = makeMockCtx();

    const handled = await handleCommand("/sessions", ctx);

    expect(handled).toBe(true);
    expect(sent[0]).toBe(
      "Could not list sessions. Start chatting to create one.",
    );
  });

  it("renders a single card with Input.ChoiceSet for sessions", async () => {
    listSessionsMock.mockResolvedValue([
      makeSession({
        sessionId: "s1",
        summary: "First session",
        lastModified: NOW - 60_000,
      }),
      makeSession({
        sessionId: "s2",
        summary: "Second session",
        lastModified: NOW - 120_000,
      }),
    ]);
    const { ctx, sent } = makeMockCtx();

    await handleCommand("/sessions", ctx);

    const activity = sent[0] as {
      attachments: Array<{ content: Record<string, unknown> }>;
    };
    expect(activity.attachments.length).toBe(1);

    const card = activity.attachments[0].content;
    expect(card.type).toBe("AdaptiveCard");

    const body = card.body as Array<Record<string, unknown>>;
    expect(body[0].text).toBe("Sessions");

    const choiceSet = body[1];
    expect(choiceSet.type).toBe("Input.ChoiceSet");
    expect(choiceSet.style).toBe("expanded");

    const choices = choiceSet.choices as Array<{ title: string; value: string }>;
    expect(choices.length).toBe(2);
    expect(choices[0].title).toContain("First session");
    expect(choices[0].value).toBe("s1");
    expect(choices[1].title).toContain("Second session");
    expect(choices[1].value).toBe("s2");
  });

  it("pre-selects active session in ChoiceSet", async () => {
    stateValues.managed = {
      session: { currentSessionId: "s1" },
      setCtx: vi.fn(),
      pendingMessages: [],
    };
    listSessionsMock.mockResolvedValue([
      makeSession({
        sessionId: "s1",
        summary: "Active one",
        lastModified: NOW,
      }),
      makeSession({
        sessionId: "s2",
        summary: "Other one",
        lastModified: NOW - 60_000,
      }),
    ]);
    const { ctx, sent } = makeMockCtx();

    await handleCommand("/sessions", ctx);

    const card = (
      sent[0] as { attachments: Array<{ content: Record<string, unknown> }> }
    ).attachments[0].content;
    const body = card.body as Array<Record<string, unknown>>;
    const choiceSet = body[1];
    expect(choiceSet.value).toBe("s1");

    const choices = choiceSet.choices as Array<{ title: string; value: string }>;
    expect(choices[0].title).toContain("Active one");
    expect(choices[1].title).toContain("Other one");

    const actions = card.actions as Array<{
      title: string;
      data: Record<string, unknown>;
    }>;
    expect(actions.length).toBe(2);
    expect(actions[0].title).toBe("Submit");
    expect(actions[1].title).toBe("Cancel");
  });

  it("Submit button carries sessionCwds lookup", async () => {
    listSessionsMock.mockResolvedValue([
      makeSession({ sessionId: "s1", cwd: "/work/my-project" }),
    ]);
    const { ctx, sent } = makeMockCtx();

    await handleCommand("/sessions", ctx);

    const card = (
      sent[0] as { attachments: Array<{ content: Record<string, unknown> }> }
    ).attachments[0].content;
    const actions = card.actions as Array<{ data: Record<string, unknown> }>;

    expect(actions[0].data).toEqual({
      action: "resume_session",
      sessionCwds: { s1: "/work/my-project" },
    });
    expect(actions[1].data).toEqual({ action: "noop" });
  });

  it("shows customTitle over summary", async () => {
    listSessionsMock.mockResolvedValue([
      makeSession({ customTitle: "My Title", summary: "auto summary" }),
    ]);
    const { ctx, sent } = makeMockCtx();

    await handleCommand("/sessions", ctx);

    const card = (
      sent[0] as { attachments: Array<{ content: Record<string, unknown> }> }
    ).attachments[0].content;
    const body = card.body as Array<Record<string, unknown>>;
    const choices = (body[1] as Record<string, unknown>).choices as Array<{ title: string }>;
    expect(choices[0].title).toContain("My Title");
    expect(choices[0].title).not.toContain("auto summary");
  });

  it("shows git branch and dir name in meta", async () => {
    listSessionsMock.mockResolvedValue([
      makeSession({ cwd: "/home/user/my-app", gitBranch: "feat/login" }),
    ]);
    const { ctx, sent } = makeMockCtx();

    await handleCommand("/sessions", ctx);

    const card = (
      sent[0] as { attachments: Array<{ content: Record<string, unknown> }> }
    ).attachments[0].content;
    const body = card.body as Array<Record<string, unknown>>;
    const choices = (body[1] as Record<string, unknown>).choices as Array<{ title: string }>;
    const title = choices[0].title;
    expect(title).toContain("my-app");
    expect(title).toContain("feat/login");
    expect(title).not.toContain("/home/user/my-app");
  });

  it("shows bot title over customTitle", async () => {
    vi.mocked(state.getBotTitle).mockReturnValue("Bot Title");
    listSessionsMock.mockResolvedValue([
      makeSession({ customTitle: "SDK Title", summary: "auto summary" }),
    ]);
    const { ctx, sent } = makeMockCtx();

    await handleCommand("/sessions", ctx);

    const card = (
      sent[0] as { attachments: Array<{ content: Record<string, unknown> }> }
    ).attachments[0].content;
    const body = card.body as Array<Record<string, unknown>>;
    const choices = (body[1] as Record<string, unknown>).choices as Array<{ title: string }>;
    expect(choices[0].title).toContain("Bot Title");
    expect(choices[0].title).not.toContain("SDK Title");
  });

  it("sorts by lastModified descending", async () => {
    listSessionsMock.mockResolvedValue([
      makeSession({
        sessionId: "old",
        summary: "Old",
        lastModified: NOW - 300_000,
      }),
      makeSession({
        sessionId: "new",
        summary: "New",
        lastModified: NOW - 10_000,
      }),
    ]);
    const { ctx, sent } = makeMockCtx();

    await handleCommand("/sessions", ctx);

    const card = (
      sent[0] as { attachments: Array<{ content: Record<string, unknown> }> }
    ).attachments[0].content;
    const body = card.body as Array<Record<string, unknown>>;
    const choices = (body[1] as Record<string, unknown>).choices as Array<{ title: string; value: string }>;
    expect(choices[0].title).toContain("New");
    expect(choices[1].title).toContain("Old");
  });
});

describe("/session name command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateValues.managed = null;
  });

  it("shows usage when no title provided", async () => {
    const { ctx, sent } = makeMockCtx();
    const handled = await handleCommand("/session name", ctx);
    expect(handled).toBe(true);
    expect(sent[0]).toContain("Usage:");
  });

  it("shows error when no active session", async () => {
    stateValues.managed = null;
    const { ctx, sent } = makeMockCtx();
    const handled = await handleCommand("/session name My Project", ctx);
    expect(handled).toBe(true);
    expect(sent[0]).toContain("No active session");
  });

  it("sets title and confirms when session is active", async () => {
    stateValues.managed = {
      session: { currentSessionId: "s1" },
      setCtx: vi.fn(),
      pendingMessages: [],
    };
    const { ctx, sent } = makeMockCtx();
    const handled = await handleCommand("/session name My Project", ctx);
    expect(handled).toBe(true);
    expect(vi.mocked(state.setSessionTitle)).toHaveBeenCalledWith(
      "s1",
      "My Project",
    );
    expect(sent[0]).toContain("My Project");
  });

  it("returns false for unknown /session subcommand", async () => {
    const { ctx } = makeMockCtx();
    const handled = await handleCommand("/session unknown", ctx);
    expect(handled).toBe(false);
  });
});
