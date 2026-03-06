/**
 * Tests for file diff extraction from SDK tool_use_result messages.
 * Covers: gitDiff.patch, structuredPatch fallback, missing data, FileWriteOutput.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClaudeResult, ProgressEvent } from "../src/claude/agent.js";

const mockQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => mockQuery(args),
  getSessionMessages: vi.fn().mockResolvedValue([]),
}));

import {
  ConversationSession,
  type SessionConfig,
} from "../src/claude/session.js";

function makeSession(overrides: Partial<SessionConfig> = {}) {
  const events: ProgressEvent[] = [];
  const results: ClaudeResult[] = [];
  let resultResolve: ((r: ClaudeResult) => void) | null = null;

  const config: SessionConfig = {
    cwd: "/work/test",
    permissionMode: "default",
    onProgress: (e) => events.push(e),
    onResult: (r) => {
      results.push(r);
      if (resultResolve) { resultResolve(r); resultResolve = null; }
    },
    ...overrides,
  };

  return {
    session: new ConversationSession(config),
    events,
    results,
    nextResult: () => new Promise<ClaudeResult>((resolve) => {
      if (results.length > 0) { resolve(results[results.length - 1]); return; }
      resultResolve = resolve;
    }),
  };
}

describe("file diff extraction from tool_use_result", () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it("extracts gitDiff.patch from FileEditOutput", async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield {
        type: "user",
        message: { role: "user", content: [] },
        parent_tool_use_id: "tu1",
        session_id: "s1",
        tool_use_result: {
          filePath: "src/index.ts",
          oldString: "const a = 1;",
          newString: "const a = 2;",
          originalFile: "const a = 1;\nconst b = 2;",
          structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-const a = 1;", "+const a = 2;"] }],
          userModified: false,
          replaceAll: false,
          gitDiff: {
            filename: "src/index.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
            changes: 2,
            patch: "@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n const b = 2;",
          },
        },
      };
      yield { type: "result", result: "Done" };
    });

    const { session, events, nextResult } = makeSession();
    session.send("edit file");
    await nextResult();

    const diffEvents = events.filter((e) => e.type === "file_diff");
    expect(diffEvents).toHaveLength(1);
    expect(diffEvents[0]).toEqual({
      type: "file_diff",
      filePath: "src/index.ts",
      patch: "@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n const b = 2;",
    });
  });

  it("falls back to structuredPatch when gitDiff is absent", async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield {
        type: "user",
        message: { role: "user", content: [] },
        parent_tool_use_id: "tu1",
        session_id: "s1",
        tool_use_result: {
          filePath: "src/app.ts",
          oldString: "x",
          newString: "y",
          originalFile: "x",
          structuredPatch: [
            { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-x", "+y"] },
          ],
          userModified: false,
          replaceAll: false,
        },
      };
      yield { type: "result", result: "Done" };
    });

    const { session, events, nextResult } = makeSession();
    session.send("edit");
    await nextResult();

    const diffEvents = events.filter((e) => e.type === "file_diff");
    expect(diffEvents).toHaveLength(1);
    expect(diffEvents[0]).toEqual({
      type: "file_diff",
      filePath: "src/app.ts",
      patch: "-x\n+y",
    });
  });

  it("joins multiple structuredPatch hunks", async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield {
        type: "user",
        message: { role: "user", content: [] },
        parent_tool_use_id: "tu1",
        session_id: "s1",
        tool_use_result: {
          filePath: "multi.ts",
          oldString: "a",
          newString: "b",
          originalFile: "a\nc\ne",
          structuredPatch: [
            { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] },
            { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ["-e", "+f"] },
          ],
          userModified: false,
          replaceAll: false,
        },
      };
      yield { type: "result", result: "Done" };
    });

    const { session, events, nextResult } = makeSession();
    session.send("edit");
    await nextResult();

    const diff = events.find((e) => e.type === "file_diff");
    expect(diff).toBeDefined();
    if (diff?.type === "file_diff") {
      expect(diff.patch).toBe("-a\n+b\n-e\n+f");
    }
  });

  it("emits file_diff with no patch when both gitDiff and structuredPatch are empty", async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield {
        type: "user",
        message: { role: "user", content: [] },
        parent_tool_use_id: "tu1",
        session_id: "s1",
        tool_use_result: {
          filePath: "empty.ts",
          oldString: "",
          newString: "",
          originalFile: "",
          structuredPatch: [],
          userModified: false,
          replaceAll: false,
        },
      };
      yield { type: "result", result: "Done" };
    });

    const { session, events, nextResult } = makeSession();
    session.send("edit");
    await nextResult();

    const diff = events.find((e) => e.type === "file_diff");
    expect(diff).toBeDefined();
    if (diff?.type === "file_diff") {
      expect(diff.filePath).toBe("empty.ts");
      expect(diff.patch).toBeUndefined();
    }
  });

  it("handles FileWriteOutput (new file creation) with gitDiff", async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield {
        type: "user",
        message: { role: "user", content: [] },
        parent_tool_use_id: "tu1",
        session_id: "s1",
        tool_use_result: {
          type: "create",
          filePath: "new-file.ts",
          content: "hello",
          structuredPatch: [
            { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+hello"] },
          ],
          originalFile: null,
          gitDiff: {
            filename: "new-file.ts",
            status: "added",
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: "@@ -0,0 +1 @@\n+hello",
          },
        },
      };
      yield { type: "result", result: "Done" };
    });

    const { session, events, nextResult } = makeSession();
    session.send("create file");
    await nextResult();

    const diff = events.find((e) => e.type === "file_diff");
    expect(diff).toEqual({
      type: "file_diff",
      filePath: "new-file.ts",
      patch: "@@ -0,0 +1 @@\n+hello",
    });
  });

  it("ignores tool_use_result without filePath", async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield {
        type: "user",
        message: { role: "user", content: [] },
        parent_tool_use_id: "tu1",
        session_id: "s1",
        tool_use_result: {
          someField: "value",
          otherField: 123,
        },
      };
      yield { type: "result", result: "Done" };
    });

    const { session, events, nextResult } = makeSession();
    session.send("do something");
    await nextResult();

    const diffEvents = events.filter((e) => e.type === "file_diff");
    expect(diffEvents).toHaveLength(0);
  });

  it("ignores tool_use_result with filePath but no gitDiff/structuredPatch", async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield {
        type: "user",
        message: { role: "user", content: [] },
        parent_tool_use_id: "tu1",
        session_id: "s1",
        tool_use_result: {
          filePath: "src/foo.ts",
          content: "some content",
        },
      };
      yield { type: "result", result: "Done" };
    });

    const { session, events, nextResult } = makeSession();
    session.send("read file");
    await nextResult();

    const diffEvents = events.filter((e) => e.type === "file_diff");
    expect(diffEvents).toHaveLength(0);
  });

  it("emits tool_result for string tool_use_result", async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield {
        type: "user",
        message: { role: "user", content: [] },
        parent_tool_use_id: "tu1",
        session_id: "s1",
        tool_use_result: "Command output: success",
      };
      yield { type: "result", result: "Done" };
    });

    const { session, events, nextResult } = makeSession();
    session.send("run command");
    await nextResult();

    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    if (toolResults[0]?.type === "tool_result") {
      expect(toolResults[0].result).toBe("Command output: success");
    }
  });

  it("prefers gitDiff.patch over structuredPatch", async () => {
    const gitPatch = "@@ -1 +1 @@\n-old\n+new";
    mockQuery.mockImplementation(async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield {
        type: "user",
        message: { role: "user", content: [] },
        parent_tool_use_id: "tu1",
        session_id: "s1",
        tool_use_result: {
          filePath: "prefer.ts",
          oldString: "old",
          newString: "new",
          originalFile: "old",
          structuredPatch: [
            { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] },
          ],
          userModified: false,
          replaceAll: false,
          gitDiff: {
            filename: "prefer.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
            changes: 2,
            patch: gitPatch,
          },
        },
      };
      yield { type: "result", result: "Done" };
    });

    const { session, events, nextResult } = makeSession();
    session.send("edit");
    await nextResult();

    const diff = events.find((e) => e.type === "file_diff");
    if (diff?.type === "file_diff") {
      // Should use gitDiff.patch (includes @@ header), not structuredPatch lines
      expect(diff.patch).toBe(gitPatch);
    }
  });
});
