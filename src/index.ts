import { config } from "./config.js";
import { App, ExpressAdapter } from "@microsoft/teams.apps";
import { DevtoolsPlugin } from "@microsoft/teams.dev";
import { MessageActivity } from "@microsoft/teams.api";
import type { ActivityParams } from "@microsoft/teams.api";
import type { Request, Response } from "express";
import {
  buildHandoffCard,
  handleCardAction,
  interactiveCards,
} from "./bot/cards.js";
import { loadConversationRefs } from "./handoff/store.js";
import { registerHandoffRoute } from "./handoff/api.js";
import { getSession, loadPersistedState } from "./session/state.js";
import { registerMessageHandler } from "./bot/message.js";
import { handleHandoff } from "./bot/bridge.js";

// Load persisted state
loadConversationRefs();
loadPersistedState();

// Express adapter — gives us access to express get/post for custom routes
const expressAdapter = new ExpressAdapter();

// Security headers for custom routes
expressAdapter.use((_req: Request, res: Response, next: () => void) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// Health check (GET route via Express adapter)
expressAdapter.get("/healthz", (_req: Request, res: Response) => {
  const session = getSession();
  res.json({
    status: "ok",
    uptimeSec: Math.floor(process.uptime()),
    pid: process.pid,
    port: config.port,
    session: {
      active: Boolean(session),
      hasQuery: session?.session.hasQuery ?? false,
    },
  });
});

// Handoff API — called by /handoff skill in Claude Code
registerHandoffRoute(expressAdapter);

// ─── Teams SDK App ───────────────────────────────────────────────────
const plugins =
  process.env.TEAMS_DEVTOOLS === "1" ? [new DevtoolsPlugin()] : [];

const teamsApp = new App({
  httpServerAdapter: expressAdapter,
  plugins,
  activity: {
    mentions: { stripText: true },
  },
});

// ─── Card action handler (Action.Execute) ────────────────────────────
teamsApp.on("card.action", async (ctx) => {
  const data = (ctx.activity.value?.action?.data ?? {}) as Record<
    string,
    unknown
  >;
  const conversationId = ctx.ref.conversation?.id;

  const sendFn = async (activity: string | ActivityParams) => {
    await ctx.send(activity);
  };

  const deleteFn = conversationId
    ? async (activityId: string) => {
        await ctx.api.conversations
          .activities(conversationId)
          .delete(activityId);
      }
    : undefined;

  const response = await handleCardAction(
    data,
    sendFn,
    deleteFn,
    ctx.activity.replyToId,
  );

  // Wire handoff actions that need app-level access
  const action = data.action as string | undefined;
  if (action === "handoff_fork") {
    const card = buildHandoffCard(
      data.workDir as string,
      data.sessionId as string | undefined,
    );
    await ctx.send(new MessageActivity().addCard("adaptive", card));
  }

  if (action === "handoff_accept" && conversationId) {
    // Update the card in-place with "Handed off" status
    const cardActivityId = ctx.activity.replyToId;
    if (cardActivityId) {
      try {
        const updatedCard = buildHandoffCard(
          data.workDir as string,
          data.sessionId as string | undefined,
          data.summary as string | undefined,
          data.todos as { content: string; done: boolean }[] | undefined,
          undefined,
          data.title as string | undefined,
          "✅ Handed off",
        );
        await ctx.api.conversations
          .activities(conversationId)
          .update(
            cardActivityId,
            new MessageActivity().addCard("adaptive", updatedCard),
          );
      } catch {
        /* card may be gone */
      }
    }

    // Fire-and-forget handoff in background
    handleHandoff(
      teamsApp,
      conversationId,
      interactiveCards,
      "handoff_accept",
      data.workDir as string,
      data.sessionId as string | undefined,
    ).catch((err: unknown) =>
      console.error("[HANDOFF] Background error:", err),
    );
  }

  return response;
});

// ─── Message handler + lifecycle ─────────────────────────────────────
registerMessageHandler(teamsApp);

// ─── Error handler (must be after all routes) ──────────────────────
expressAdapter.use(
  // Express identifies error handlers by their 4-argument signature
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  (err: Error & { type?: string }, _req: Request, res: Response, _next: () => void) => {
    if (err.type === "entity.too.large") {
      console.warn("[BOT] Payload too large — rejecting request");
      res.status(413).json({ error: "Message too large to process." });
      return;
    }
    console.error("[BOT] Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  },
);

// ─── Start ───────────────────────────────────────────────────────────
teamsApp.start(config.port).then(() => {
  if (process.env.TEAMS_DEVTOOLS === "1") {
    console.log(`DevTools on :${config.port + 1}`);
  }
});
