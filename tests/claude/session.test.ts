import { describe, it, expect, vi, beforeEach } from "vitest";
import { ERROR_CODES } from "../../src/errors/error-codes.js";
import type { ClaudeResult, ProgressEvent } from "../../src/claude/types.js";

const mockQuery = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => mockQuery(args),
}));

import {
  ConversationSession,
  type SessionConfig,
} from "../../src/claude/session.js";

function makeSession(overrides: Partial<SessionConfig> = {}): {
  session: ConversationSession;
  events: ProgressEvent[];
  results: ClaudeResult[];
  nextResult: () => Promise<ClaudeResult>;
} {
  const events: ProgressEvent[] = [];
  const results: ClaudeResult[] = [];
  let consumedCount = 0;
  let resultResolve: ((r: ClaudeResult) => void) | null = null;

  const config: SessionConfig = {
    cwd: "/work/test",
    permissionMode: "default",
    onProgress: (e) => events.push(e),
    onResult: (r) => {
      results.push(r);
      if (resultResolve !== null && results.length > consumedCount) {
        const next = results[consumedCount];
        consumedCount += 1;
        resultResolve(next);
        resultResolve = null;
      }
    },
    ...overrides,
  };

  return {
    session: new ConversationSession(config),
    events,
    results,
    nextResult: () =>
      new Promise<ClaudeResult>((resolve) => {
        if (results.length > consumedCount) {
          const next = results[consumedCount];
          consumedCount += 1;
          resolve(next);
          return;
        }
        resultResolve = resolve;
      }),
  };
}

describe("ConversationSession lifecycle", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("sends first message and captures session ID", async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-123" };
      yield { type: "result", result: "Done!" };
    });

    const onSessionId = vi.fn();
    const { session, nextResult } = makeSession({ onSessionId });

    session.send("hello world");
    const result = await nextResult();

    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockQuery.mock.calls[0][0].prompt).toBe("hello world");
    expect(result.result).toBe("Done!");
    expect(onSessionId).toHaveBeenCalledWith("sess-123");
  });

  it("passes cwd to SDK options", async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: "result", result: "OK" };
    });

    const { session, nextResult } = makeSession({ cwd: "/home/user/project" });
    session.send("start");
    await nextResult();

    expect(mockQuery.mock.calls[0][0].options.cwd).toBe("/home/user/project");
  });

  it("uses default permission mode by default", async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: "result", result: "OK" };
    });

    const { session, nextResult } = makeSession();
    session.send("test");
    await nextResult();

    expect(mockQuery.mock.calls[0][0].options.permissionMode).toBe("default");
  });

  it("uses provided permissionMode", async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: "result", result: "OK" };
    });

    const { session, nextResult } = makeSession({
      permissionMode: "bypassPermissions",
    });
    session.send("test");
    await nextResult();

    expect(mockQuery.mock.calls[0][0].options.permissionMode).toBe(
      "bypassPermissions",
    );
  });

  it("returns error when SDK throws during query creation", async () => {
    mockQuery.mockImplementation(() => {
      throw new Error("API rate limited");
    });

    const { session, nextResult } = makeSession();
    session.send("test");

    expect((await nextResult()).error).toContain("API rate limited");
  });

  it("attaches structured errorCode when SDK creation fails", async () => {
    mockQuery.mockImplementation(() => {
      throw new Error("API rate_limit reached");
    });

    const { session, nextResult } = makeSession();
    session.send("test");

    await expect(nextResult()).resolves.toMatchObject({
      errorCode: ERROR_CODES.CLAUDE_RATE_LIMITED,
    });
  });

  it("maps spaced rate limit errors to structured errorCode", async () => {
    mockQuery.mockImplementation(() => {
      throw new Error("API rate limit reached");
    });

    const { session, nextResult } = makeSession();
    session.send("test");

    await expect(nextResult()).resolves.toMatchObject({
      errorCode: ERROR_CODES.CLAUDE_RATE_LIMITED,
    });
  });

  it("streams subsequent user messages via streamInput", async () => {
    const streamInput = vi.fn().mockResolvedValue(undefined);

    mockQuery.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-stream" };
        yield { type: "result", result: "first" };
      },
      streamInput,
      interrupt: vi.fn(),
      close: vi.fn(),
      supportedCommands: vi.fn(),
      setPermissionMode: vi.fn(),
      setModel: vi.fn(),
      stopTask: vi.fn(),
    });

    const { session, nextResult } = makeSession();
    session.send("first");
    await nextResult();

    // After result, activeQuery is cleared - next send starts new query with resume
    session.send("second");
    await vi.waitFor(() => {
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockQuery.mock.calls[1][0].options.resume).toBe("sess-stream");
    });
  });

  it("interrupt calls SDK interrupt on active query", async () => {
    const interrupt = vi.fn().mockResolvedValue(undefined);

    mockQuery.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-int" };
        await new Promise(() => {});
      },
      streamInput: vi.fn(),
      interrupt,
      close: vi.fn(),
      supportedCommands: vi.fn(),
      setPermissionMode: vi.fn(),
      setModel: vi.fn(),
      stopTask: vi.fn(),
    });

    const { session } = makeSession();
    session.send("first");

    await vi.waitFor(() => {
      expect(session.hasQuery).toBe(true);
    });

    await session.interrupt();
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it("close cleans up resources and marks session closed", async () => {
    const close = vi.fn();

    mockQuery.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        await new Promise(() => {});
      },
      streamInput: vi.fn(),
      interrupt: vi.fn(),
      close,
      supportedCommands: vi.fn(),
      setPermissionMode: vi.fn(),
      setModel: vi.fn(),
      stopTask: vi.fn(),
    });

    const { session } = makeSession();
    session.send("test");

    await vi.waitFor(() => {
      expect(session.hasQuery).toBe(true);
    });

    session.close();

    expect(session.isClosed).toBe(true);
    expect(session.hasQuery).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });

  it("returns error result if sending after close", async () => {
    const { session, nextResult } = makeSession();
    session.close();
    session.send("hello");

    const result = await nextResult();
    expect(result.error).toBe("Session is closed");
    expect(result.errorCode).toBe(ERROR_CODES.SESSION_CLOSED);
    expect(result.tools).toEqual([]);
  });

  it("restarts a finished query using the latest session id as resume", async () => {
    let call = 0;
    mockQuery.mockImplementation(async function* () {
      call += 1;
      yield {
        type: "system",
        subtype: "init",
        session_id: call === 1 ? "sess-first" : "sess-second",
      };
      yield { type: "result", result: call === 1 ? "first" : "second" };
    });

    const { session, nextResult } = makeSession();

    session.send("first message");
    await expect(nextResult()).resolves.toMatchObject({
      sessionId: "sess-first",
      result: "first",
    });

    await vi.waitFor(() => {
      expect(session.hasQuery).toBe(false);
    });

    session.send("second message");
    await expect(nextResult()).resolves.toMatchObject({
      sessionId: "sess-second",
      result: "second",
    });

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[0][0].options.resume).toBeUndefined();
    expect(mockQuery.mock.calls[1][0].options.resume).toBe("sess-first");
  });

  it("uses forkSession only on first query startup", async () => {
    let call = 0;
    mockQuery.mockImplementation(async function* () {
      call += 1;
      yield {
        type: "system",
        subtype: "init",
        session_id: call === 1 ? "sess-forked" : "sess-followup",
      };
      yield { type: "result", result: "ok" };
    });

    const { session, nextResult } = makeSession({
      resume: "sess-parent",
      forkSession: true,
    });

    session.send("first turn");
    await nextResult();

    await vi.waitFor(() => {
      expect(session.hasQuery).toBe(false);
    });

    session.send("second turn");
    await nextResult();

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[0][0].options.resume).toBe("sess-parent");
    expect(mockQuery.mock.calls[0][0].options.forkSession).toBe(true);
    expect(mockQuery.mock.calls[1][0].options.resume).toBe("sess-forked");
    expect(mockQuery.mock.calls[1][0].options.forkSession).toBeUndefined();
  });

  it("emits error result when resuming query fails", async () => {
    let callCount = 0;
    mockQuery.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          [Symbol.asyncIterator]: async function* () {
            yield { type: "system", subtype: "init", session_id: "sess-resume" };
            yield { type: "result", result: "first" };
          },
          streamInput: vi.fn(),
          interrupt: vi.fn(),
          close: vi.fn(),
          supportedCommands: vi.fn(),
          setPermissionMode: vi.fn(),
          setModel: vi.fn(),
          stopTask: vi.fn(),
        };
      }
      // Second query (resume) fails
      throw new Error("resume failed");
    });

    const { session, nextResult } = makeSession();
    session.send("first");
    await nextResult();

    session.send("second");
    await expect(nextResult()).resolves.toMatchObject({
      error: "resume failed",
    });
  });
});
