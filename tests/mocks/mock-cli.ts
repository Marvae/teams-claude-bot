import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = "sdk-responses";

function fixturePath(name: string): string {
  return resolve(__dirname, `../fixtures/${name}.json`);
}

function parseFixtureArg(argv: string[]): string {
  const fixtureFlagIndex = argv.indexOf("--fixture");
  if (fixtureFlagIndex >= 0 && argv[fixtureFlagIndex + 1]) {
    return argv[fixtureFlagIndex + 1];
  }
  return DEFAULT_FIXTURE;
}

function loadFixture(name: string): Record<string, unknown> {
  try {
    const raw = readFileSync(fixturePath(name), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    if (name === DEFAULT_FIXTURE) {
      return {};
    }

    try {
      const fallbackRaw = readFileSync(fixturePath(DEFAULT_FIXTURE), "utf8");
      return JSON.parse(fallbackRaw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

function toPromptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textParts = content
      .map((item) => {
        if (item && typeof item === "object" && "type" in item && "text" in item) {
          const chunk = item as { type?: unknown; text?: unknown };
          if (chunk.type === "text" && typeof chunk.text === "string") {
            return chunk.text;
          }
        }
        return "";
      })
      .filter((part) => part.length > 0);
    return textParts.join("\n");
  }
  return "";
}

function extractAck(prompt: string): string {
  const match = prompt.match(/ACK:([A-Za-z0-9_-]+)/);
  return match?.[1] ?? "MOCK_ACK";
}

function buildInitMessage(
  sessionId: string,
  fixture: Record<string, unknown>,
): Record<string, unknown> {
  const fixtureDefault = fixture.default as Record<string, unknown> | undefined;
  const defaults = (fixtureDefault?.init as Record<string, unknown> | undefined) ?? {};

  return {
    type: "system",
    subtype: "init",
    apiKeySource: "oauth",
    claude_code_version: "mock-1.0.0",
    cwd: process.cwd(),
    tools: ["Read", "Glob", "Grep", "AskUserQuestion"],
    mcp_servers: [],
    model: "claude-sonnet-4-6",
    permissionMode: "default",
    slash_commands: ["/help"],
    output_style: "default",
    skills: [],
    plugins: [],
    ...defaults,
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

function buildResultMessage(sessionId: string, ackId: string): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 20,
    duration_api_ms: 15,
    is_error: false,
    num_turns: 1,
    result: `ACK:${ackId}`,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1,
      service_tier: "standard",
    },
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

function writeJsonLine(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function replaceSessionId(value: unknown, sessionId: string): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{session_id\}\}/g, sessionId);
  }

  if (Array.isArray(value)) {
    return value.map((item) => replaceSessionId(item, sessionId));
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      replaceSessionId(v, sessionId),
    ]);
    return Object.fromEntries(entries);
  }

  return value;
}

function main(): void {
  const selectedFixture = parseFixtureArg(process.argv.slice(2));
  const fixture = loadFixture(selectedFixture);
  const sessionId = randomUUID();

  const fixtureDefault = fixture.default as Record<string, unknown> | undefined;
  const resultDelayMs = Math.max(
    0,
    Number(fixtureDefault?.resultDelayMs ?? 15),
  );

  const rawMessagesByInput = fixture.messagesByInput;
  const messagesByInput = Array.isArray(rawMessagesByInput)
    ? rawMessagesByInput
    : undefined;

  let initSent = false;
  let inputCount = 0;
  let pendingWrites = 0;
  let closed = false;
  let scheduleCursorMs = 0;

  function maybeExit(): void {
    if (closed && pendingWrites === 0) {
      setTimeout(() => {
        process.exit(0);
      }, 5);
    }
  }

  function schedule(payload: Record<string, unknown>, delayMs: number): void {
    pendingWrites += 1;
    setTimeout(() => {
      writeJsonLine(payload);
      pendingWrites -= 1;
      maybeExit();
    }, delayMs);
  }

  function scheduleSequence(sequence: unknown[]): void {
    const baseDelay = scheduleCursorMs;
    sequence.forEach((message, index) => {
      const payload = replaceSessionId(message, sessionId);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        schedule(payload as Record<string, unknown>, baseDelay + index * resultDelayMs);
      }
    });
    scheduleCursorMs += sequence.length * resultDelayMs;
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    if (messagesByInput) {
      const sequence = messagesByInput[inputCount];
      inputCount += 1;

      if (Array.isArray(sequence)) {
        scheduleSequence(sequence);
      }
      return;
    }

    const msg = parsed as {
      type?: unknown;
      message?: { content?: unknown };
    };
    if (msg.type !== "user") return;

    if (!initSent) {
      schedule(buildInitMessage(sessionId, fixture), 0);
      initSent = true;
    }

    const prompt = toPromptText(msg.message?.content);
    const ackId = extractAck(prompt);
    schedule(buildResultMessage(sessionId, ackId), resultDelayMs);
  });

  rl.on("close", () => {
    closed = true;
    maybeExit();
  });
}

main();
