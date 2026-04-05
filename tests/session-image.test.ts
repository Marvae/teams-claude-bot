/**
 * ConversationSession tests — image extraction from tool results.
 * Tests: FileReadOutput images, BashOutput screenshots, original file fallback.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClaudeResult, ProgressEvent } from "../src/claude/agent.js";

// Mock the SDK
const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => mockQuery(args),
  getSessionMessages: vi.fn().mockResolvedValue([]),
}));

// Mock fs/promises — must be hoisted before session.ts import
const mockReadFile = vi.fn();
vi.mock("fs/promises", () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

import {
  ConversationSession,
  type SessionConfig,
} from "../src/claude/session.js";

const SMALL_PNG_B64 = "aWNvbi1kYXRh"; // fake base64

function makeSession(overrides: Partial<SessionConfig> = {}): {
  session: ConversationSession;
  events: ProgressEvent[];
  results: ClaudeResult[];
  nextResult: () => Promise<ClaudeResult>;
} {
  const events: ProgressEvent[] = [];
  const results: ClaudeResult[] = [];
  let resultResolve: ((r: ClaudeResult) => void) | null = null;

  const config: SessionConfig = {
    cwd: "/work/test",
    permissionMode: "default",
    onProgress: (e) => events.push(e),
    onResult: (r) => {
      results.push(r);
      if (resultResolve) {
        resultResolve(r);
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
        if (results.length > 0) {
          resolve(results[results.length - 1]);
          return;
        }
        resultResolve = resolve;
      }),
  };
}

describe("ConversationSession — image extraction", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockReadFile.mockReset();
  });

  it("emits image event from FileReadOutput with SDK base64 (no original path)", async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      // user message with image tool result — no matching Read in readToolPaths
      yield {
        type: "user",
        parent_tool_use_id: null,
        tool_use_result: {
          type: "image",
          file: { type: "image/png", base64: SMALL_PNG_B64 },
        },
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-999" }],
        },
      };
      yield { type: "result", result: "Done" };
    });

    const { session, events, nextResult } = makeSession();
    session.send("read image");
    await nextResult();

    const imageEvents = events.filter((e) => e.type === "image");
    expect(imageEvents).toHaveLength(1);
    const img = imageEvents[0] as Extract<ProgressEvent, { type: "image" }>;
    expect(img.base64).toBe(SMALL_PNG_B64);
    expect(img.mimeType).toBe("image/png");
  });

  it("reads original file when Read tool path is tracked", async () => {
    const originalContent = Buffer.from("original-image-data");
    mockReadFile.mockResolvedValue(originalContent);

    mockQuery.mockImplementation(async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      // assistant uses Read tool
      yield {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-42",
              name: "Read",
              input: { file_path: "/tmp/screenshot.png" },
            },
          ],
        },
      };
      // user message with image result referencing tool-42
      yield {
        type: "user",
        parent_tool_use_id: null,
        tool_use_result: {
          type: "image",
          file: { type: "image/png", base64: SMALL_PNG_B64 },
        },
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-42" }],
        },
      };
      yield { type: "result", result: "Done" };
    });

    const { session, events, nextResult } = makeSession();
    session.send("read screenshot");
    await nextResult();

    const imageEvents = events.filter((e) => e.type === "image");
    expect(imageEvents).toHaveLength(1);
    const img = imageEvents[0] as Extract<ProgressEvent, { type: "image" }>;
    expect(img.base64).toBe(originalContent.toString("base64"));
    expect(img.sizeBytes).toBe(originalContent.length);
    expect(img.name).toBe("screenshot.png");
    expect(mockReadFile).toHaveBeenCalledWith("/tmp/screenshot.png");
  });

  it("falls back to SDK base64 when original file read fails", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    mockQuery.mockImplementation(async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-50",
              name: "Read",
              input: { file_path: "/tmp/gone.png" },
            },
          ],
        },
      };
      yield {
        type: "user",
        parent_tool_use_id: null,
        tool_use_result: {
          type: "image",
          file: { type: "image/png", base64: SMALL_PNG_B64, originalSize: 5000 },
        },
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-50" }],
        },
      };
      yield { type: "result", result: "Done" };
    });

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { session, events, nextResult } = makeSession();
    session.send("read image");
    await nextResult();

    const imageEvents = events.filter((e) => e.type === "image");
    expect(imageEvents).toHaveLength(1);
    const img = imageEvents[0] as Extract<ProgressEvent, { type: "image" }>;
    // Should fall back to SDK version
    expect(img.base64).toBe(SMALL_PNG_B64);
    expect(img.sizeBytes).toBe(5000);
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("emits image event from BashOutput screenshot", async () => {
    const screenshotB64 = "c2NyZWVuc2hvdA=="; // fake base64
    mockQuery.mockImplementation(async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield {
        type: "user",
        parent_tool_use_id: null,
        tool_use_result: {
          isImage: true,
          stdout: screenshotB64,
        },
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-bash" }],
        },
      };
      yield { type: "result", result: "Done" };
    });

    const { session, events, nextResult } = makeSession();
    session.send("take screenshot");
    await nextResult();

    const imageEvents = events.filter((e) => e.type === "image");
    expect(imageEvents).toHaveLength(1);
    const img = imageEvents[0] as Extract<ProgressEvent, { type: "image" }>;
    expect(img.base64).toBe(screenshotB64);
    expect(img.mimeType).toBe("image/png");
  });

  it("emits image from nested tool_result content block (MCP tools)", async () => {
    const mcpImageB64 = "bWNwLWltYWdl"; // fake base64
    mockQuery.mockImplementation(async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield {
        type: "user",
        parent_tool_use_id: null,
        tool_use_result: { "0": "some opaque mcp result" },
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-mcp",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/jpeg",
                    data: mcpImageB64,
                  },
                },
              ],
            },
          ],
        },
      };
      yield { type: "result", result: "Done" };
    });

    const { session, events, nextResult } = makeSession();
    session.send("mcp screenshot");
    await nextResult();

    const imageEvents = events.filter((e) => e.type === "image");
    expect(imageEvents).toHaveLength(1);
    const img = imageEvents[0] as Extract<ProgressEvent, { type: "image" }>;
    expect(img.base64).toBe(mcpImageB64);
    expect(img.mimeType).toBe("image/jpeg");
  });

  it("skips image when file.base64 is missing", async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield {
        type: "user",
        parent_tool_use_id: null,
        tool_use_result: {
          type: "image",
          file: { type: "image/png" }, // no base64 field
        },
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-no-b64" }],
        },
      };
      yield { type: "result", result: "Done" };
    });

    const { session, events, nextResult } = makeSession();
    session.send("read broken image");
    await nextResult();

    const imageEvents = events.filter((e) => e.type === "image");
    expect(imageEvents).toHaveLength(0);
  });
});
