import { config } from "./config.js";
import { BotFrameworkAdapter, TurnContext } from "botbuilder";
import express from "express";
import { ClaudeCodeBot } from "./bot/teams-bot.js";
import { buildHandoffCard } from "./bot/cards.js";
import { loadConversationRefs, getConversationRef } from "./handoff/store.js";

// Load persisted state (conversation refs only — session created lazily on first message)
loadConversationRefs();

// Bot Framework adapter
const adapter = new BotFrameworkAdapter({
  appId: config.microsoftAppId,
  appPassword: config.microsoftAppPassword,
  channelAuthTenant: config.microsoftAppTenantId,
});

adapter.onTurnError = async (context, error) => {
  console.error(`[ERROR] ${error}`);
  try {
    await context.sendActivity("Something went wrong. Try again.");
  } catch {
    // Ignore send errors in error handler
  }
};

// Bot instance
const bot = new ClaudeCodeBot();

// Express server
const app = express();
app.use(express.json());

app.post("/api/messages", async (req, res) => {
  try {
    await adapter.process(req, res, (context) => bot.run(context));
  } catch (err) {
    console.error(`[AUTH] ${err instanceof Error ? err.message : err}`);
    if (!res.headersSent) {
      res.status(401).end();
    }
  }
});

// Handoff API - called by Terminal skill to notify Teams
app.post("/api/handoff", async (req, res) => {
  // Verify handoff token if configured
  if (config.handoffToken) {
    const token = req.headers["x-handoff-token"];
    if (token !== config.handoffToken) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
  }

  const { workDir, sessionId, mode: _mode } = req.body ?? {};

  const ref = getConversationRef();
  if (!ref) {
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

    console.log("[HANDOFF] Handoff card sent to Teams");
    res.json({ success: true });
  } catch (err) {
    console.error(`[HANDOFF] ${err}`);
    res.status(500).json({
      success: false,
      error: "Failed to send notification",
    });
  }
});

app.listen(config.port, () => {
  console.log(`Bot running on http://localhost:${config.port}/api/messages`);
  console.log(`Working directory: ${config.claudeWorkDir}`);
});
