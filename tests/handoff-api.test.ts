import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock config before importing the module under test
vi.mock("../src/config.js", () => ({
  config: {
    microsoftAppId: "test-app-id",
    microsoftAppPassword: "test-secret",
    microsoftAppTenantId: "test-tenant",
    handoffToken: "valid-token",
    port: 3978,
    claudeWorkDir: "/tmp",
  },
}));

// Mock store
const mockGetConversationId = vi.fn<() => string | null>();
vi.mock("../src/handoff/store.js", () => ({
  getConversationId: (...args: unknown[]) => mockGetConversationId(...(args as [])),
}));

// Mock state
vi.mock("../src/session/state.js", () => ({
  getWorkDir: () => "/tmp/test",
}));

// Mock buildHandoffCard
vi.mock("../src/bot/cards.js", () => ({
  buildHandoffCard: (...args: unknown[]) => ({
    type: "AdaptiveCard",
    version: "1.4",
    body: [{ type: "TextBlock", text: `card:${(args as string[])[0]}` }],
  }),
}));

// Mock global fetch
const mockFetch = vi.fn<typeof fetch>();

describe("handoff API", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = mockFetch;
    mockGetConversationId.mockReturnValue("a:test-conversation-id");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Helper: create mock req/res
  function createMockReqRes(body: object, headers: Record<string, string> = {}) {
    const req = {
      ip: "127.0.0.1",
      headers: { "x-handoff-token": "valid-token", ...headers },
      body,
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    return { req, res };
  }

  // Import the handler dynamically so mocks are in place
  async function getHandler() {
    const mod = await import("../src/handoff/api.js");
    // Extract handleHandoffRequest by registering on a fake adapter
    let handler: (req: unknown, res: unknown) => Promise<void>;
    const fakeAdapter = {
      post: (_path: string, _middleware: unknown, h: typeof handler) => {
        handler = h;
      },
    };
    mod.registerHandoffRoute(fakeAdapter as never);
    return handler!;
  }

  it("rejects unauthorized requests", async () => {
    const handler = await getHandler();
    const { req, res } = createMockReqRes({}, { "x-handoff-token": "wrong" });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Unauthorized" }),
    );
  });

  it("returns 404 when no conversation ID exists", async () => {
    mockGetConversationId.mockReturnValue(null);
    const handler = await getHandler();
    const { req, res } = createMockReqRes({ workDir: "C:/test" });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("First time setup") }),
    );
  });

  it("sends handoff card successfully", async () => {
    // Mock token response
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "test-bot-token" }), {
        status: 200,
      }),
    );
    // Mock Bot Framework send response
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "activity-123" }), { status: 201 }),
    );

    const handler = await getHandler();
    const { req, res } = createMockReqRes({
      workDir: "C:/Users/test",
      sessionId: "abc-123",
      title: "Test",
      summary: "Test summary",
      buttonText: "Go",
    });

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith({ success: true });

    // Verify token request
    const tokenCall = mockFetch.mock.calls[0];
    expect(tokenCall[0]).toContain("login.microsoftonline.com/test-tenant");
    const tokenBody = tokenCall[1]?.body as URLSearchParams;
    expect(tokenBody.get("client_id")).toBe("test-app-id");
    expect(tokenBody.get("scope")).toBe(
      "https://api.botframework.com/.default",
    );

    // Verify activity send
    const sendCall = mockFetch.mock.calls[1];
    expect(sendCall[0]).toContain(
      "/v3/conversations/a:test-conversation-id/activities",
    );
    expect((sendCall[1]?.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-bot-token",
    );
  });

  it("handles token acquisition failure", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "invalid_client", error_description: "bad secret" }),
        { status: 400 },
      ),
    );

    const handler = await getHandler();
    const { req, res } = createMockReqRes({ workDir: "C:/test" });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("bot token") }),
    );
  });

  it("handles expired conversation ID", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }),
    );
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { code: "BadArgument", message: "Failed to decrypt conversation id" },
        }),
        { status: 403 },
      ),
    );

    const handler = await getHandler();
    const { req, res } = createMockReqRes({ workDir: "C:/test" });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("Conversation expired") }),
    );
  });

  it("handles 403 auth rejection", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }),
    );
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
    );

    const handler = await getHandler();
    const { req, res } = createMockReqRes({ workDir: "C:/test" });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("Teams rejected") }),
    );
  });

  it("rate limits after 10 requests", async () => {
    const handler = await getHandler();

    // Exhaust rate limit (10 requests from same IP)
    for (let i = 0; i < 10; i++) {
      const { req, res } = createMockReqRes(
        {},
        { "x-handoff-token": "wrong" },
      );
      await handler(req, res);
    }

    // 11th should be rate limited
    const { req, res } = createMockReqRes({});
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(429);
  });
});
