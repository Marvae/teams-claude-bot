import { config } from "./config.js";
import { BotFrameworkAdapter } from "botbuilder";
import express from "express";
import { ClaudeCodeBot } from "./bot/teams-bot.js";
import { loadSessions } from "./session/manager.js";

// Load persisted sessions
loadSessions();

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
  await adapter.process(req, res, (context) => bot.run(context));
});

app.listen(config.port, () => {
  console.log(
    `Bot running on http://localhost:${config.port}/api/messages`,
  );
  console.log(`Working directory: ${config.claudeWorkDir}`);
});
