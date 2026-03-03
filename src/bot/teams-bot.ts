import {
  ActivityHandler,
  ActivityTypes,
  TurnContext,
} from "botbuilder";
import { stripMention } from "./mention.js";
import { handleCommand } from "./commands.js";
import {
  clearSession,
  getSession,
  setSession,
  setWorkDir,
  getWorkDir,
  getModel,
  getThinkingTokens,
  getPermissionMode,
  switchToSession,
  setContinueMode,
  consumeContinueMode,
} from "../session/manager.js";
import { runClaude, type ImageInput } from "../claude/agent.js";
import { formatResponse, splitMessage } from "../claude/formatter.js";
import { processAttachments } from "./attachments.js";
import { config } from "../config.js";
import { saveConversationRef } from "../handoff/store.js";

export class ClaudeCodeBot extends ActivityHandler {
  constructor() {
    super();
    this.onMessage(async (ctx, next) => {
      saveConversationRef(ctx);
      await this.handleMessage(ctx);
      await next();
    });
  }

  private isUserAllowed(ctx: TurnContext): boolean {
    if (config.allowedUsers.size === 0) return true;
    const aadId = ctx.activity.from.aadObjectId?.toLowerCase();
    const name = ctx.activity.from.name?.toLowerCase();
    if (aadId && config.allowedUsers.has(aadId)) return true;
    if (name && config.allowedUsers.has(name)) return true;
    return false;
  }

  private isValidTeamsRequest(ctx: TurnContext): boolean {
    // Verify request comes from legitimate Teams service
    const serviceUrl = ctx.activity.serviceUrl;
    if (!serviceUrl) return false;

    // Known Teams service URLs
    const validDomains = [
      'https://smba.trafficmanager.net',
      'https://amer.ng.msg.teams.microsoft.com',
      'https://apac.ng.msg.teams.microsoft.com',
      'https://emea.ng.msg.teams.microsoft.com',
      'https://northamerica.ng.msg.teams.microsoft.com',
      'https://southamerica.ng.msg.teams.microsoft.com',
      'https://europe.ng.msg.teams.microsoft.com',
      'https://asia.ng.msg.teams.microsoft.com'
    ];

    const isValid = validDomains.some(domain => serviceUrl.startsWith(domain));

    if (!isValid) {
      console.warn(`[SECURITY] Rejected request from unknown service: ${serviceUrl}`);
    }

    return isValid;
  }

  private async handleMessage(ctx: TurnContext): Promise<void> {
    // Security: Log request origin (validation handled by Bot Framework JWT)
    if (!this.isValidTeamsRequest(ctx)) {
      console.warn('[SECURITY] Unknown service origin - allowing (JWT already validated by adapter)');
    }

    // Access control check
    if (!this.isUserAllowed(ctx)) {
      await ctx.sendActivity(
        "Sorry, you are not authorized to use this bot.",
      );
      return;
    }

    // Handle Adaptive Card button clicks
    const value = ctx.activity.value as Record<string, unknown> | undefined;
    if (value?.action) {
      const conversationId = ctx.activity.conversation.id;

      if (value.action === "resume_session") {
        const switched = switchToSession(conversationId, value.index as number);
        if (switched) {
          await ctx.sendActivity(`🔄 Resumed session\n\n📂 ${switched.workDir}`);
        } else {
          await ctx.sendActivity("Session not found.");
        }
        return;
      }

      if (value.action === "handoff_resume") {
        const wd = value.workDir as string;
        const sid = value.sessionId as string | undefined;
        if (sid) {
          setSession(conversationId, sid);
        }
        setWorkDir(conversationId, wd);
        await ctx.sendActivity(`🔄 Resumed Terminal session\n\n📂 ${wd}\n\nSend a message to continue.`);
        return;
      }

      if (value.action === "handoff_dismiss") {
        await ctx.sendActivity("Dismissed. Current session unchanged.");
        return;
      }

      return;
    }

    let text = (ctx.activity.text ?? "").trim();
    console.log(`[BOT] Message text: "${text}"`);

    const conversationId = ctx.activity.conversation.id;

    // Process attachments (images, text files)
    let images: ImageInput[] | undefined;
    const attachments = ctx.activity.attachments?.filter(
      (a) => a.contentType !== "text/html",
    );
    if (attachments && attachments.length > 0) {
      const processed = await processAttachments(ctx, attachments);
      if (processed.images.length > 0) {
        images = processed.images;
      }
      if (processed.textSnippets.length > 0) {
        text = processed.textSnippets.join("\n\n") + "\n\n" + text;
      }
      if (processed.unsupported.length > 0) {
        await ctx.sendActivity(
          `Skipped unsupported files: ${processed.unsupported.join(", ")}`,
        );
      }
    }

    if (!text && !images) return;

    // Strip @mention in group chats
    text = stripMention(text);
    if (!text && !images) return;

    // Handle slash commands (only for text-only messages)
    if (!images && (await handleCommand(text, conversationId, ctx))) return;

    // Start typing indicator loop
    console.log('[BOT] Starting typing indicator and Claude API call');
    const typingController = new AbortController();
    const typingLoop = this.startTypingLoop(ctx, typingController.signal);

    try {
      console.log('[BOT] Calling runClaude...');
      const result = await runClaude(
        text || "What is in this image?",
        getSession(conversationId),
        getWorkDir(conversationId),
        getModel(conversationId),
        getThinkingTokens(conversationId),
        getPermissionMode(conversationId),
        images,
      );

      console.log('[BOT] runClaude completed, stopping typing');
      // Stop typing
      typingController.abort();
      await typingLoop;

      if (result.error) {
        console.log(`[BOT] Error from Claude: ${result.error}`);
        await ctx.sendActivity(`Error: \`${result.error}\``);
        return;
      }

      if (result.sessionId) {
        setSession(conversationId, result.sessionId);
      }

      console.log('[BOT] Formatting and sending response');
      const response = formatResponse(result);
      const chunks = splitMessage(response);

      for (const chunk of chunks) {
        await ctx.sendActivity(chunk);
      }
      console.log('[BOT] Response sent successfully');
    } catch (err) {
      console.error('[BOT] Error in handleMessage:', err);
      typingController.abort();
      await typingLoop;
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.sendActivity(`Error: \`${msg.slice(0, 500)}\``);
    }
  }

  private async startTypingLoop(
    ctx: TurnContext,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        await ctx.sendActivity({ type: ActivityTypes.Typing });
      } catch {
        // Ignore typing indicator errors
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  }
}
