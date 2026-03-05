import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  processMessage,
  type EventProcessorContext,
  type EventProcessorState,
} from "../../src/claude/event-processor.js";
import type { ClaudeResult, ProgressEvent } from "../../src/claude/types.js";

type FixtureMessage = Record<string, unknown>;
type FixtureFile = {
  messagesByInput: FixtureMessage[][];
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../fixtures");
const mockCliPath = resolve(__dirname, "../mocks/mock-cli.mjs");

function loadFixture(name: string): FixtureFile {
  const raw = readFileSync(resolve(fixturesDir, `${name}.json`), "utf8");
  return JSON.parse(raw) as FixtureFile;
}

function flattenMessages(name: string): FixtureMessage[] {
  const fixture = loadFixture(name);
  return fixture.messagesByInput.flat();
}

function replaceSessionId(value: unknown, sessionId: string): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{session_id\}\}/g, sessionId);
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceSessionId(item, sessionId));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        replaceSessionId(v, sessionId),
      ]),
    );
  }
  return value;
}

function makeHarness(overrides: Partial<EventProcessorContext> = {}) {
  const events: ProgressEvent[] = [];
  const results: ClaudeResult[] = [];
  const sessionIds: string[] = [];
  let closed = false;

  const state: EventProcessorState = {
    turnTools: [],
    turnStreamingText: "",
  };

  const context: EventProcessorContext = {
    onSessionId: vi.fn((sessionId: string) => {
      sessionIds.push(sessionId);
      state.sessionId = sessionId;
    }),
    onPromptRequest: vi.fn(),
    onProgress: (event) => events.push(event),
    onResult: async (result) => {
      results.push(result);
    },
    sendPromptResponse: vi.fn().mockResolvedValue(undefined),
    markClosed: () => {
      closed = true;
    },
    ...overrides,
  };

  return { state, context, events, results, sessionIds, isClosed: () => closed };
}

async function runFixtureThroughEventProcessor(name: string, sessionId: string) {
  const { state, context, events, results, sessionIds, isClosed } = makeHarness();
  const messages = flattenMessages(name).map((msg) =>
    replaceSessionId(msg, sessionId),
  ) as FixtureMessage[];

  for (const message of messages) {
    // eslint-disable-next-line no-await-in-loop
    await processMessage(message, state, context);
  }

  return { state, context, events, results, sessionIds, isClosed };
}

describe("SDK fixture scenarios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("multi-turn fixture emits two result callbacks and done events", async () => {
    const run = await runFixtureThroughEventProcessor("multi-turn", "sess-multi");

    expect(run.sessionIds).toEqual(["sess-multi"]);
    expect(run.results.map((r) => r.result)).toEqual(["Hi there!", "4"]);
    expect(run.events.filter((e) => e.type === "done")).toHaveLength(2);
  });

  it("tool-use fixture collects tools and emits tool summary callback", async () => {
    const run = await runFixtureThroughEventProcessor("tool-use", "sess-tool");

    expect(run.results).toHaveLength(1);
    expect(run.results[0]?.tools).toEqual([{ name: "Read", file: "README.md" }]);
    expect(run.events).toContainEqual({
      type: "tool_summary",
      summary: "Read README.md successfully",
    });
  });

  it("permission-flow fixture requests prompt response and continues after approval", async () => {
    const onPromptRequest = vi.fn().mockResolvedValue("approved");
    const sendPromptResponse = vi.fn().mockResolvedValue(undefined);

    const run = await runFixtureThroughEventProcessor("permission-flow", "sess-perm");

    // Re-run with prompt handlers enabled to validate callback flow.
    const withPrompt = makeHarness({ onPromptRequest, sendPromptResponse });
    const messages = flattenMessages("permission-flow").map((msg) =>
      replaceSessionId(msg, "sess-perm"),
    ) as FixtureMessage[];

    for (const message of messages) {
      // eslint-disable-next-line no-await-in-loop
      await processMessage(message, withPrompt.state, withPrompt.context);
    }

    expect(onPromptRequest).toHaveBeenCalledTimes(1);
    expect(sendPromptResponse).toHaveBeenCalledWith("perm-write-1", "approved");
    expect(withPrompt.results.map((r) => r.result)).toEqual([
      "Write completed after approval.",
    ]);

    expect(run.results).toHaveLength(1);
  });

  it("interrupt fixture yields interrupted result with streamed partial text", async () => {
    const run = await runFixtureThroughEventProcessor("interrupt", "sess-int");

    expect(run.events).toContainEqual({ type: "text", text: "Working..." });
    expect(run.results).toHaveLength(1);
    expect(run.results[0]).toMatchObject({
      interrupted: true,
      result: "Working...",
      sessionId: "sess-int",
    });
  });
});

describe("mock CLI fixture sequencing", () => {
  it("outputs fixture-defined message sequence for --fixture multi-turn", async () => {
    const output = await new Promise<string>((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [mockCliPath, "--fixture", "multi-turn"], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });

      child.on("error", rejectPromise);
      child.on("close", (code) => {
        if (code !== 0) {
          rejectPromise(new Error(stderr || `mock-cli exited with code ${code}`));
          return;
        }
        resolvePromise(stdout);
      });

      child.stdin.write(
        `${JSON.stringify({
          type: "user",
          message: { role: "user", content: "Hello" },
        })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({
          type: "user",
          message: { role: "user", content: "What's 2+2?" },
        })}\n`,
      );
      child.stdin.end();
    });

    const lines = output
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines.map((line) => `${line.type}:${line.subtype ?? ""}`)).toEqual([
      "system:init",
      "assistant:",
      "result:success",
      "assistant:",
      "result:success",
    ]);

    expect(lines[2]?.result).toBe("Hi there!");
    expect(lines[4]?.result).toBe("4");
  });
});
