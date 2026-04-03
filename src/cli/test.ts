/**
 * `teams-bot test` — Send messages to the bot via DevTools and see responses.
 *
 * Requires the bot to be running in development mode (DevTools on port+1).
 * Messages are sent through the full bot pipeline including Claude Agent SDK.
 *
 * Usage:
 *   teams-bot test                        # Interactive REPL
 *   teams-bot test "What is 2+2?"         # One-shot: send, print reply, exit
 *   teams-bot test --card prompt_response  # Simulate Adaptive Card action
 */

import readline from "readline";

const DEFAULT_BOT_PORT = 3978;

interface ActivityEvent {
  id: string;
  type: string;
  body: {
    type?: string;
    text?: string;
    attachments?: Array<{
      contentType: string;
      content: Record<string, unknown>;
    }>;
    channelData?: Record<string, unknown>;
    [key: string]: unknown;
  };
  sentAt: string;
}

function getDevToolsPort(): number {
  const port = parseInt(process.env.PORT || String(DEFAULT_BOT_PORT), 10);
  return port + 1;
}

function getDevToolsUrl(): string {
  return `http://localhost:${getDevToolsPort()}`;
}

function getWsUrl(): string {
  return `ws://localhost:${getDevToolsPort()}/devtools/sockets`;
}

async function checkDevTools(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${getDevToolsUrl()}/devtools/`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function sendActivity(
  conversationId: string,
  activity: Record<string, unknown>,
): Promise<string> {
  const url = `${getDevToolsUrl()}/v3/conversations/${conversationId}/activities`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-teams-devtools": "true",
    },
    body: JSON.stringify(activity),
  });
  if (!res.ok) {
    throw new Error(`DevTools API returned ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { id: string };
  return data.id;
}

function formatResponse(event: ActivityEvent): string {
  const body = event.body;

  // Skip typing indicators
  if (body.type === "typing") return "";

  // Text message
  if (body.text) return body.text;

  // Adaptive Card
  if (body.attachments?.length) {
    const card = body.attachments[0];
    if (card.contentType === "application/vnd.microsoft.card.adaptive") {
      const content = card.content;
      const bodyElements = content.body as Array<{
        type: string;
        text?: string;
      }>;
      if (bodyElements) {
        const texts = bodyElements
          .filter((el) => el.type === "TextBlock" && el.text)
          .map((el) => el.text);
        const actions = content.actions as Array<{
          type: string;
          title?: string;
          data?: Record<string, unknown>;
        }>;
        let result = "[Adaptive Card]\n" + texts.join("\n");
        if (actions?.length) {
          result +=
            "\n[Actions] " +
            actions
              .map(
                (a) =>
                  `${a.title || "?"}${a.data?.action ? ` (${a.data.action})` : ""}`,
              )
              .join(" | ");
        }
        return result;
      }
    }
    return `[Attachment: ${card.contentType}]`;
  }

  return JSON.stringify(body).substring(0, 200);
}

type WsLike = {
  addEventListener(
    type: string,
    handler: (event: { data: string }) => void,
  ): void;
  close(): void;
};

function connectWebSocket(): Promise<WsLike> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(getWsUrl());
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () =>
      reject(new Error("WebSocket connection failed")),
    );
  });
}

function collectResponses(
  ws: WsLike,
  timeoutMs: number,
): Promise<ActivityEvent[]> {
  return new Promise((resolve) => {
    const events: ActivityEvent[] = [];
    let silenceTimer: ReturnType<typeof setTimeout>;

    const resetSilence = () => {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => resolve(events), timeoutMs);
    };

    ws.addEventListener("message", (e: { data: string }) => {
      const parsed = JSON.parse(e.data) as ActivityEvent;
      if (parsed.type === "activity.sent") {
        events.push(parsed);
        resetSilence();
      }
    });

    resetSilence();
  });
}

// ── One-shot mode ───────────────────────────────────────────────────────

async function oneShot(message: string): Promise<void> {
  const ws = await connectWebSocket();
  const responsePromise = collectResponses(ws, 5000);

  await sendActivity("a:devtools-test", { type: "message", text: message });

  const events = await responsePromise;
  ws.close();

  for (const event of events) {
    const text = formatResponse(event);
    if (text) console.log(text);
  }

  if (events.length === 0) {
    console.log("(no response received within timeout)");
  }
}

// ── Card simulation mode ────────────────────────────────────────────────

async function simulateCard(action: string): Promise<void> {
  const presets: Record<string, Record<string, unknown>> = {
    prompt_response: {
      action: "prompt_response",
      requestId: `test-${Date.now()}`,
      key: "allow",
    },
    permission_allow: {
      action: "permission_allow",
      toolUseID: `test-${Date.now()}`,
    },
    permission_deny: {
      action: "permission_deny",
      toolUseID: `test-${Date.now()}`,
    },
    set_permission_mode: {
      action: "set_permission_mode",
      mode: "default",
    },
  };

  const value = presets[action];
  if (!value) {
    console.log(`Unknown card action: ${action}`);
    console.log(`Available: ${Object.keys(presets).join(", ")}`);
    return;
  }

  const ws = await connectWebSocket();
  const responsePromise = collectResponses(ws, 3000);

  await sendActivity("a:devtools-test", {
    type: "message",
    text: "",
    value,
  });

  console.log(`Sent Action.Submit: ${action}`);

  const events = await responsePromise;
  ws.close();

  for (const event of events) {
    const text = formatResponse(event);
    if (text) console.log(text);
  }
}

// ── Interactive REPL mode ───────────────────────────────────────────────

async function repl(): Promise<void> {
  const ws = await connectWebSocket();

  ws.addEventListener("message", (e: { data: string }) => {
    const parsed = JSON.parse(e.data) as ActivityEvent;
    if (parsed.type === "activity.sent") {
      const text = formatResponse(parsed);
      if (text) {
        console.log(`\n${text}`);
        rl.prompt();
      }
    }
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "you> ",
  });

  console.log("Interactive test mode. Type messages to send to the bot.");
  console.log('Type "exit" or Ctrl+C to quit.\n');
  rl.prompt();

  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }
    if (text === "exit" || text === "quit") {
      ws.close();
      rl.close();
      return;
    }

    try {
      await sendActivity("a:devtools-test", { type: "message", text });
    } catch (err) {
      console.error(
        `Send failed: ${err instanceof Error ? err.message : err}`,
      );
      rl.prompt();
    }
  });

  rl.on("close", () => {
    ws.close();
  });
}

// ── Diagnose mode ───────────────────────────────────────────────────────
// Focuses on the DevTools test path. For bot + tunnel health, use `teams-bot health`.

async function diagnose(): Promise<void> {
  const devPort = getDevToolsPort();

  // 1. DevTools reachable
  process.stdout.write(`DevTools (localhost:${devPort}) ... `);
  const dtOk = await checkDevTools();
  console.log(dtOk ? "OK" : "FAIL (not reachable — is NODE_ENV=production?)");
  if (!dtOk) {
    console.log("\nBot must be running in dev mode. Run: npm run dev:local");
    return;
  }

  // 2. WebSocket
  process.stdout.write("WebSocket ... ");
  let ws: WsLike;
  try {
    ws = await connectWebSocket();
    console.log("OK");
  } catch {
    console.log("FAIL (cannot connect)");
    return;
  }

  // 3. Send /help (local only, no tunnel)
  process.stdout.write("Bot pipeline (/help) ... ");
  try {
    const responsePromise = collectResponses(ws, 8000);
    await sendActivity("a:diag", { type: "message", text: "/help" });
    const events = await responsePromise;
    const replies = events.filter(
      (e) => e.body.type !== "typing" && (e.body.text || e.body.attachments),
    );
    console.log(
      replies.length > 0
        ? `OK (${replies.length} reply)`
        : "FAIL (no response)",
    );
  } catch (err) {
    console.log(`FAIL (${err instanceof Error ? err.message : String(err)})`);
  }

  ws.close();
  console.log(
    "\nLocal pipeline OK means bot logic works. If Teams still fails, run: teams-bot health",
  );
}

// ── Entry point ─────────────────────────────────────────────────────────

export async function testCommand(
  message?: string,
  options?: { card?: string; diagnose?: boolean },
): Promise<void> {
  if (options?.diagnose) {
    await diagnose();
    return;
  }

  const ok = await checkDevTools();
  if (!ok) {
    console.error(
      `DevTools not reachable at ${getDevToolsUrl()}/devtools/\n` +
        "Make sure the bot is running in dev mode (npm run dev or npm run dev:local).",
    );
    process.exitCode = 1;
    return;
  }

  if (options?.card) {
    await simulateCard(options.card);
  } else if (message) {
    await oneShot(message);
  } else {
    await repl();
  }
}
