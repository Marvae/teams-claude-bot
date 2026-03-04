import { config } from "./config.js";
import { BotFrameworkAdapter, TurnContext } from "botbuilder";
import express from "express";
import { resolve } from "node:path";
import { ClaudeCodeBot } from "./bot/teams-bot.js";
import { loadSessions } from "./session/manager.js";
import { loadConversationRefs, getConversationRef } from "./handoff/store.js";
import { isVoiceEnabled, wrapVoiceTranscript } from "./voice/index.js";
import { processVoiceUpload } from "./voice/tab-api.js";

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

// Serve static files (Voice Tab HTML)
app.use(express.static(resolve(process.cwd(), "public")));

// JSON body parser — increase limit for base64-encoded audio uploads
app.use(express.json({ limit: "50mb" }));

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
    await adapter.continueConversation(ref, async (ctx: TurnContext) => {
      await bot.handleHandoff(ctx, "handoff_fork", workDir, sessionId);
    });

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

// Voice Tab API — receives audio from Voice Tab, transcribes, sends to chat
app.post("/api/voice", async (req, res) => {
  const { audio, mimeType, userId, userName } = req.body ?? {};

  // Process the audio through whisper pipeline
  const result = await processVoiceUpload({ audio, mimeType, userId, userName });
  if (!result.success || !result.transcript) {
    return res.status(result.error?.includes("not available") ? 503 : 400).json(result);
  }

  // Look up conversation reference to send proactive message
  const ref = getConversationRef(userId?.toLowerCase());
  if (!ref) {
    return res.status(404).json({
      success: false,
      transcript: result.transcript,
      error:
        "No chat found. Send any message to the bot in Chat first, then try again.",
    });
  }

  try {
    const wrappedTranscript = wrapVoiceTranscript(result.transcript);

    await adapter.continueConversation(ref, async (ctx: TurnContext) => {
      // Show the transcript in chat so the user sees what was said
      await ctx.sendActivity(`🎙️ ${result.transcript}`);

      // Inject into Claude session via the bot's message handler
      await bot.handleVoiceMessage(ctx, wrappedTranscript);
    });

    console.log(`[VOICE-TAB] Transcript sent to chat for ${userName || userId}`);
    res.json({ success: true, transcript: result.transcript });
  } catch (err) {
    console.error(`[VOICE-TAB] Proactive message failed:`, err);
    res.status(500).json({
      success: false,
      transcript: result.transcript,
      error: "Failed to send message to chat",
    });
  }
});

app.listen(config.port, () => {
  console.log(`Bot running on http://localhost:${config.port}/api/messages`);
  console.log(`Working directory: ${config.claudeWorkDir}`);

  // Warm voice-enabled cache and log availability
  isVoiceEnabled().catch(() => {});
});
