import { describe, it, expect, vi, beforeEach } from "vitest";

const listSessionsMock = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  listSessions: (...args: unknown[]) => listSessionsMock(...args),
}));

const sessionState = {
  sessionId: undefined as string | undefined,
  workDir: "/work/test",
};

vi.mock("../src/session/manager.js", () => ({
  getSession: vi.fn(() => sessionState.sessionId),
  setSession: vi.fn(),
  clearSession: vi.fn(),
  getWorkDir: vi.fn(() => sessionState.workDir),
  setWorkDir: vi.fn(() => ({ ok: true })),
  getModel: vi.fn(),
  setModel: vi.fn(),
  getThinkingTokens: vi.fn(),
  setThinkingTokens: vi.fn(),
  getPermissionMode: vi.fn(),
  setPermissionMode: vi.fn(),
  getHandoffMode: vi.fn(),
  clearHandoffMode: vi.fn(),
}));

import { handleCommand } from "../src/bot/commands.js";

function makeMockCtx() {
  const sent: unknown[] = [];
  return {
    ctx: {
      sendActivity: vi.fn(async (activity: unknown) => {
        sent.push(activity);
        return { id: "msg-1" };
      }),
    } as unknown as Parameters<typeof handleCommand>[2],
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
    sessionState.sessionId = undefined;
    sessionState.workDir = "/work/test";
  });

  it("shows empty message when no sessions", async () => {
    listSessionsMock.mockResolvedValue([]);
    const { ctx, sent } = makeMockCtx();

    const handled = await handleCommand("/sessions", "conv-1", ctx);

    expect(handled).toBe(true);
    expect(sent[0]).toBe("No sessions. Start chatting to create one.");
  });

  it("shows error message when listSessions throws", async () => {
    listSessionsMock.mockRejectedValue(new Error("SDK error"));
    const { ctx, sent } = makeMockCtx();

    const handled = await handleCommand("/sessions", "conv-1", ctx);

    expect(handled).toBe(true);
    expect(sent[0]).toBe(
      "Could not list sessions. Start chatting to create one.",
    );
  });

  it("renders Adaptive Card with sessions", async () => {
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

    await handleCommand("/sessions", "conv-1", ctx);

    const activity = sent[0] as {
      attachments: Array<{ content: Record<string, unknown> }>;
    };
    const card = activity.attachments[0].content;
    expect(card.type).toBe("AdaptiveCard");

    const body = card.body as Array<{ text: string }>;
    expect(body[0].text).toBe("Sessions");
    // Two sessions × 2 text blocks each + header = 5
    expect(body.length).toBe(5);
    expect(body[1].text).toContain("First session");
    expect(body[3].text).toContain("Second session");
  });

  it("highlights active session with ▶ and no button", async () => {
    sessionState.sessionId = "s1";
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

    await handleCommand("/sessions", "conv-1", ctx);

    const card = (
      sent[0] as { attachments: Array<{ content: Record<string, unknown> }> }
    ).attachments[0].content;
    const body = card.body as Array<{ text: string }>;
    const actions = card.actions as Array<{
      title: string;
      data: Record<string, unknown>;
    }>;

    // Active session has ▶ prefix
    expect(body[1].text).toContain("▶");
    expect(body[1].text).toContain("Active one");

    // Non-active session has number prefix
    expect(body[3].text).toContain("2.");
    expect(body[3].text).toContain("Other one");

    // Only one button (for the non-active session)
    expect(actions.length).toBe(1);
    expect(actions[0].title).toBe("#2");
    expect(actions[0].data.sessionId).toBe("s2");
  });

  it("buttons carry sessionId and cwd", async () => {
    listSessionsMock.mockResolvedValue([
      makeSession({ sessionId: "s1", cwd: "/work/my-project" }),
    ]);
    const { ctx, sent } = makeMockCtx();

    await handleCommand("/sessions", "conv-1", ctx);

    const card = (
      sent[0] as { attachments: Array<{ content: Record<string, unknown> }> }
    ).attachments[0].content;
    const actions = card.actions as Array<{ data: Record<string, unknown> }>;

    expect(actions[0].data).toEqual({
      action: "resume_session",
      sessionId: "s1",
      cwd: "/work/my-project",
    });
  });

  it("shows customTitle over summary", async () => {
    listSessionsMock.mockResolvedValue([
      makeSession({ customTitle: "My Title", summary: "auto summary" }),
    ]);
    const { ctx, sent } = makeMockCtx();

    await handleCommand("/sessions", "conv-1", ctx);

    const card = (
      sent[0] as { attachments: Array<{ content: Record<string, unknown> }> }
    ).attachments[0].content;
    const body = card.body as Array<{ text: string }>;
    expect(body[1].text).toContain("My Title");
    expect(body[1].text).not.toContain("auto summary");
  });

  it("shows git branch and dir name in meta", async () => {
    listSessionsMock.mockResolvedValue([
      makeSession({ cwd: "/home/user/my-app", gitBranch: "feat/login" }),
    ]);
    const { ctx, sent } = makeMockCtx();

    await handleCommand("/sessions", "conv-1", ctx);

    const card = (
      sent[0] as { attachments: Array<{ content: Record<string, unknown> }> }
    ).attachments[0].content;
    const body = card.body as Array<{ text: string }>;
    const meta = body[2].text;
    expect(meta).toContain("my-app");
    expect(meta).toContain("feat/login");
    // Should NOT contain full path
    expect(meta).not.toContain("/home/user/my-app");
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

    await handleCommand("/sessions", "conv-1", ctx);

    const card = (
      sent[0] as { attachments: Array<{ content: Record<string, unknown> }> }
    ).attachments[0].content;
    const body = card.body as Array<{ text: string }>;
    // Newer session should be first (after header)
    expect(body[1].text).toContain("New");
    expect(body[3].text).toContain("Old");
  });
});
