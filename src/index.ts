import { config } from "./config.js";
import { BotFrameworkAdapter, TurnContext } from "botbuilder";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { ClaudeCodeBot } from "./bot/teams-bot.js";
import { buildHandoffCard } from "./bot/cards.js";
import { loadConversationRefs, getConversationRef } from "./handoff/store.js";
import { loadPersistedState } from "./session/state.js";
import { logError, logInfo, toError } from "./logging/logger.js";

// Simple in-memory rate limiter (no external dependencies)
function rateLimit(windowMs: number, maxRequests: number) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    const windowStart = now - windowMs;
    const timestamps = (hits.get(ip) ?? []).filter((t) => t > windowStart);
    if (timestamps.length >= maxRequests) {
      res.status(429).json({ error: "Too many requests" });
      return;
    }
    timestamps.push(now);
    hits.set(ip, timestamps);
    // Periodic cleanup
    if (hits.size > 1000) {
      for (const [key, ts] of hits) {
        if (ts.every((t) => t <= windowStart)) hits.delete(key);
      }
    }
    next();
  };
}

try {
  loadConversationRefs();
  loadPersistedState();
  logInfo("BOOT", "state_loaded");
} catch (error) {
  logError("BOOT", "state_load_failed", error);
}

// Bot Framework adapter
const adapter = new BotFrameworkAdapter({
  appId: config.microsoftAppId,
  appPassword: config.microsoftAppPassword,
  channelAuthTenant: config.microsoftAppTenantId,
});

adapter.onTurnError = async (context, error) => {
  logError("BOT", "turn_error", error, {
    conversationId: context.activity.conversation?.id,
    activityId: context.activity.id,
  });
  try {
    await context.sendActivity("Something went wrong. Try again.");
  } catch (sendError) {
    logError("BOT", "turn_error_notify_failed", sendError);
  }
};

// Bot instance
const bot = new ClaudeCodeBot();

// Express server
const app = express();

// Security headers
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

app.use(express.json());

app.post("/api/messages", async (req, res) => {
  try {
    logInfo("HTTP", "messages_received", { method: req.method });
    await adapter.process(req, res, (context) => bot.run(context));
    logInfo("HTTP", "messages_processed");
  } catch (err) {
    logError("HTTP", "messages_auth_failed", err);
    if (!res.headersSent) {
      res.status(401).end();
    }
  }
});

// Handoff API - called by Terminal skill to notify Teams
app.post("/api/handoff", rateLimit(60_000, 10), async (req, res) => {
  const token = req.headers["x-handoff-token"];
  if (token !== config.handoffToken) {
    logInfo("HANDOFF", "unauthorized");
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  const { workDir, sessionId, mode: _mode } = req.body ?? {};

  const ref = getConversationRef();
  if (!ref) {
    logInfo("HANDOFF", "conversation_ref_missing", {
      sessionId: typeof sessionId === "string" ? sessionId : undefined,
    });
    return res.status(404).json({
      success: false,
      error:
        "First time setup: send any message to the bot in Teams first, then retry /handoff. This is only needed once.",
    });
  }

  try {
    // Send handoff card to Teams — user must click Accept to switch
    await adapter.continueConversation(ref, async (ctx: TurnContext) => {
      const card = buildHandoffCard(workDir, sessionId);
      await ctx.sendActivity({
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: card,
          },
        ],
      });
    });

    logInfo("HANDOFF", "card_sent", {
      sessionId: typeof sessionId === "string" ? sessionId : undefined,
      workDir: typeof workDir === "string" ? workDir : undefined,
    });
    res.json({ success: true });
  } catch (err) {
    logError("HANDOFF", "send_failed", err, {
      sessionId: typeof sessionId === "string" ? sessionId : undefined,
      workDir: typeof workDir === "string" ? workDir : undefined,
    });
    res.status(500).json({
      success: false,
      error: "Failed to send notification",
    });
  }
});

app.listen(config.port, () => {
  logInfo("BOOT", "server_started", {
    port: config.port,
    workDir: config.claudeWorkDir,
  });
});

process.on("uncaughtException", (error) => {
  logError("BOOT", "uncaught_exception", error);
});

process.on("unhandledRejection", (reason) => {
  logError("BOOT", "unhandled_rejection", toError(reason));
});
