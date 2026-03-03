import { config } from "./config.js";
import { BotFrameworkAdapter, CardFactory, TurnContext } from "botbuilder";
import express from "express";
import { ClaudeCodeBot } from "./bot/teams-bot.js";
import { loadSessions } from "./session/manager.js";
import {
  loadConversationRefs,
  getConversationRef,
} from "./handoff/store.js";

// Load persisted state
loadSessions();
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

  const { workDir, sessionId, mode } = req.body ?? {};

  const ref = getConversationRef();
  if (!ref) {
    return res.status(404).json({
      success: false,
      error: "First time setup: send any message to the bot in Teams first, then retry /handoff. This is only needed once.",
    });
  }

  try {
    await adapter.continueConversation(
      ref,
      async (ctx: TurnContext) => {
        // Direct mode: skip card, call handoff handler directly
        if (mode === "pickup" || mode === "resume") {
          const action = mode === "pickup" ? "handoff_pickup" : "handoff_resume";
          await bot.handleHandoff(ctx, action, workDir, sessionId);
          return;
        }

        // Default: show Adaptive Card with both options
        const card = CardFactory.adaptiveCard({
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            {
              type: "TextBlock",
              text: "Handoff Ready",
              size: "large",
              weight: "bolder",
            },
            {
              type: "FactSet",
              facts: [
                { title: "Project", value: workDir ?? "unknown" },
                { title: "Time", value: new Date().toLocaleTimeString() },
              ],
            },
            {
              type: "TextBlock",
              text: "Quick Pickup: new session with context summary. Both sides can work independently.\nResume: same session takeover. Close Terminal first (/exit).",
              size: "small",
              isSubtle: true,
              wrap: true,
              spacing: "small",
            },
          ],
          actions: [
            {
              type: "Action.Submit",
              title: "▶️ Quick Pickup (recommended)",
              data: { action: "handoff_pickup", workDir, sessionId },
            },
            {
              type: "Action.Submit",
              title: "🔄 Resume (close Terminal first)",
              data: { action: "handoff_resume", workDir, sessionId },
            },
          ],
        });
        await ctx.sendActivity({ attachments: [card] });
      },
    );

    console.log("[HANDOFF] Proactive notification sent");
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
  console.log(
    `Bot running on http://localhost:${config.port}/api/messages`,
  );
  console.log(`Working directory: ${config.claudeWorkDir}`);
});
