import {
  ActivityHandler,
  ActivityTypes,
  TurnContext,
} from "botbuilder";
import { stripMention } from "./mention.js";
import { handleCommand } from "./commands.js";
import {
  getSession,
  setSession,
  getWorkDir,
  getModel,
  getThinkingTokens,
  getPermissionMode,
} from "../session/manager.js";
import { runClaude, type ImageInput } from "../claude/agent.js";
import { formatResponse, splitMessage } from "../claude/formatter.js";
import { processAttachments } from "./attachments.js";
import { config } from "../config.js";

export class ClaudeCodeBot extends ActivityHandler {
  constructor() {
    super();
    this.onMessage(async (ctx, next) => {
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

  private async handleMessage(ctx: TurnContext): Promise<void> {
    // Access control check
    if (!this.isUserAllowed(ctx)) {
      await ctx.sendActivity(
        "Sorry, you are not authorized to use this bot.",
      );
      return;
    }

    let text = (ctx.activity.text ?? "").trim();

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
    const typingController = new AbortController();
    const typingLoop = this.startTypingLoop(ctx, typingController.signal);

    try {
      const result = await runClaude(
        text || "What is in this image?",
        getSession(conversationId),
        getWorkDir(conversationId),
        getModel(conversationId),
        getThinkingTokens(conversationId),
        getPermissionMode(conversationId),
        images,
      );

      // Stop typing
      typingController.abort();
      await typingLoop;

      if (result.error) {
        await ctx.sendActivity(`Error: \`${result.error}\``);
        return;
      }

      if (result.sessionId) {
        setSession(conversationId, result.sessionId);
      }

      const response = formatResponse(result);
      const chunks = splitMessage(response);

      for (const chunk of chunks) {
        await ctx.sendActivity(chunk);
      }
    } catch (err) {
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
