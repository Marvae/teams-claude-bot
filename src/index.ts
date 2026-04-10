import { config } from "./config.js";
import { App, ExpressAdapter } from "@microsoft/teams.apps";
import { DevtoolsPlugin } from "@microsoft/teams.dev";
import { MessageActivity } from "@microsoft/teams.api";
import type { ActivityParams } from "@microsoft/teams.api";
import express from "express";
import type { Request, Response } from "express";
import {
  buildHandoffCard,
  handleCardAction,
  interactiveCards,
} from "./bot/cards.js";
import { loadConversationRefs, getConversationId } from "./handoff/store.js";
import { getWorkDir, getSession, loadPersistedState } from "./session/state.js";
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

// Simple in-memory rate limiter for handoff endpoint
const handoffHits = new Map<string, number[]>();
function checkHandoffRate(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - 60_000;
  const timestamps = (handoffHits.get(ip) ?? []).filter((t) => t > windowStart);
  if (timestamps.length >= 10) return false;
  timestamps.push(now);
  handoffHits.set(ip, timestamps);
  if (handoffHits.size > 1000) {
    for (const [key, ts] of handoffHits) {
      if (ts.every((t) => t <= windowStart)) handoffHits.delete(key);
    }
  }
  return true;
}

// Handoff API — called by Terminal skill to notify Teams
// Note: teamsApp is referenced before assignment but only called at runtime (after start)
expressAdapter.post(
  "/api/handoff",
  express.json(),
  async (req: Request, res: Response) => {
    const ip = req.ip ?? "unknown";
    if (!checkHandoffRate(ip)) {
      res.status(429).json({ error: "Too many requests" });
      return;
    }

    const token = req.headers["x-handoff-token"];
    if (token !== config.handoffToken) {
      res.status(401).json({ success: false, error: "Unauthorized" });
      return;
    }

    const {
      workDir: rawWorkDir,
      sessionId,
      summary,
      todos,
      buttonText,
      title,
    } = req.body ?? {};
    const workDir = (rawWorkDir as string) ?? getWorkDir();

    const conversationId = getConversationId();
    if (!conversationId) {
      res.status(404).json({
        success: false,
        error:
          "First time setup: send any message to the bot in Teams first, then retry /handoff. This is only needed once.",
      });
      return;
    }

    try {
      const card = buildHandoffCard(
        workDir,
        sessionId as string | undefined,
        summary as string | undefined,
        todos as { content: string; done: boolean }[] | undefined,
        buttonText as string | undefined,
        title as string | undefined,
      );

      // Use Bot Framework REST API directly — SDK's app.send() has token
      // scope issues that cause 403 on proactive messaging.
      const serviceUrl = (
        process.env.SERVICE_URL ?? "https://smba.trafficmanager.net/teams"
      ).replace(/\/+$/, "");
      const tokenRes = await fetch(
        `https://login.microsoftonline.com/${config.microsoftAppTenantId}/oauth2/v2.0/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: config.microsoftAppId,
            client_secret: config.microsoftAppPassword,
            scope: "https://api.botframework.com/.default",
            grant_type: "client_credentials",
          }),
        },
      );
      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        error?: string;
      };
      if (!tokenData.access_token) {
        throw new Error(
          `Token request failed: ${JSON.stringify(tokenData)}`,
        );
      }

      const activity = new MessageActivity().addCard("adaptive", card);
      const sendRes = await fetch(
        `${serviceUrl}/v3/conversations/${conversationId}/activities`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "message",
            ...activity,
          }),
        },
      );

      if (!sendRes.ok) {
        const body = await sendRes.text();
        throw new Error(`Bot Framework API ${sendRes.status}: ${body}`);
      }

      console.log("[HANDOFF] Handoff card sent to Teams");
      res.json({ success: true });
    } catch (err) {
      console.error("[HANDOFF]", err instanceof Error ? err.stack : err);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("decrypt conversation")) {
        res.status(400).json({
          success: false,
          error:
            "Conversation expired. Send a message to the bot in Teams to refresh, then retry.",
        });
      } else if (msg.includes("403") || msg.includes("401")) {
        res.status(502).json({
          success: false,
          error:
            "Teams rejected the message. Check bot credentials (MICROSOFT_APP_PASSWORD may be expired).",
        });
      } else if (msg.includes("Token request failed")) {
        res.status(502).json({
          success: false,
          error: "Could not obtain bot token. Check Azure AD app credentials.",
        });
      } else {
        res.status(500).json({
          success: false,
          error: `Failed to send notification: ${msg.slice(0, 200)}`,
        });
      }
    }
  },
);

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
