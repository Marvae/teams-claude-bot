import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = "sdk-responses";

function fixturePath(name) {
  return resolve(__dirname, `../fixtures/${name}.json`);
}

function parseFixtureArg(argv) {
  const fixtureFlagIndex = argv.indexOf("--fixture");
  if (fixtureFlagIndex >= 0 && argv[fixtureFlagIndex + 1]) {
    return argv[fixtureFlagIndex + 1];
  }
  return DEFAULT_FIXTURE;
}

function loadFixture(name) {
  try {
    const raw = readFileSync(fixturePath(name), "utf8");
    return JSON.parse(raw);
  } catch {
    if (name === DEFAULT_FIXTURE) {
      return {};
    }

    try {
      const fallbackRaw = readFileSync(fixturePath(DEFAULT_FIXTURE), "utf8");
      return JSON.parse(fallbackRaw);
    } catch {
      return {};
    }
  }
}

function toPromptText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textParts = content
      .map((item) => {
        if (item && typeof item === "object" && "type" in item && "text" in item) {
          if (item.type === "text" && typeof item.text === "string") {
            return item.text;
          }
        }
        return "";
      })
      .filter((part) => part.length > 0);
    return textParts.join("\n");
  }
  return "";
}

function extractAck(prompt) {
  const match = prompt.match(/ACK:([A-Za-z0-9_-]+)/);
  return match?.[1] ?? "MOCK_ACK";
}

function buildInitMessage(sessionId, fixture) {
  const defaults = fixture.default?.init ?? {};
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

function buildResultMessage(sessionId, ackId) {
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

function writeJsonLine(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function replaceSessionId(value, sessionId) {
  if (typeof value === "string") {
    return value.replace(/\{\{session_id\}\}/g, sessionId);
  }

  if (Array.isArray(value)) {
    return value.map((item) => replaceSessionId(item, sessionId));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, replaceSessionId(nested, sessionId)]),
    );
  }

  return value;
}

function main() {
  const selectedFixture = parseFixtureArg(process.argv.slice(2));
  const fixture = loadFixture(selectedFixture);
  const sessionId = randomUUID();
  const resultDelayMs = Math.max(0, Number(fixture.default?.resultDelayMs ?? 15));

  const messagesByInput = Array.isArray(fixture.messagesByInput)
    ? fixture.messagesByInput
    : undefined;

  let initSent = false;
  let inputCount = 0;
  let pendingWrites = 0;
  let closed = false;
  let scheduleCursorMs = 0;

  function maybeExit() {
    if (closed && pendingWrites === 0) {
      setTimeout(() => {
        process.exit(0);
      }, 5);
    }
  }

  function schedule(payload, delayMs) {
    pendingWrites += 1;
    setTimeout(() => {
      writeJsonLine(payload);
      pendingWrites -= 1;
      maybeExit();
    }, delayMs);
  }

  function scheduleSequence(sequence) {
    const baseDelay = scheduleCursorMs;
    sequence.forEach((message, index) => {
      const payload = replaceSessionId(message, sessionId);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        schedule(payload, baseDelay + index * resultDelayMs);
      }
    });
    scheduleCursorMs += sequence.length * resultDelayMs;
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;

    let parsed;
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

    if (parsed?.type !== "user") return;

    if (!initSent) {
      schedule(buildInitMessage(sessionId, fixture), 0);
      initSent = true;
    }

    const prompt = toPromptText(parsed?.message?.content);
    const ackId = extractAck(prompt);
    schedule(buildResultMessage(sessionId, ackId), resultDelayMs);
  });

  rl.on("close", () => {
    closed = true;
    maybeExit();
  });
}

main();
