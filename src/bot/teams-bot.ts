import {
  resolvePromptRequest,
  createPromptCard,
  registerPromptRequest,
} from "../claude/user-input.js";
import {
  ActivityHandler,
  ActivityTypes,
  BotFrameworkAdapter,
  TurnContext,
} from "botbuilder";
import { stripMention } from "./mention.js";
import { handleCommand } from "./commands.js";
import {
  clearSession,
  // clearHandoffMode, // TODO: use in handoff cleanup
  getSession,
  setSession,
  setWorkDir,
  getWorkDir,
  getModel,
  getThinkingTokens,
  getPermissionMode,
  switchToSession,
  setPermissionMode,
  setHandoffMode,
} from "../session/manager.js";
import {
  runClaude,
  type ImageInput,
  type ProgressEvent,
  type RunClaudeOptions,
} from "../claude/agent.js";
import { formatResponse, splitMessage } from "../claude/formatter.js";
import {
  resolvePermission,
  createPermissionHandler,
} from "../claude/permissions.js";
import { buildPermissionCard } from "./cards.js";
import { processAttachments } from "./attachments.js";
import { config } from "../config.js";
import { saveConversationRef } from "../handoff/store.js";

function friendlyError(error: string): string {
  if (error.includes("exited with code 1")) {
    return "Something went wrong with Claude Code. Try `/new` to start a fresh session.";
  }
  if (error.includes("Session not found")) {
    return "Session not found. The Terminal session may have been deleted. Try `/new` to start fresh.";
  }
  if (error.includes("ENOENT")) {
    return "Could not start Claude Code. The bot service may need to be restarted.";
  }
  if (error.includes("rate_limit") || error.includes("429")) {
    return "Claude API is rate limited. Please wait a moment and try again.";
  }
  if (error.includes("token") || error.includes("context_length")) {
    return "Conversation is too long. Use `/new` to start a fresh session.";
  }
  if (error.includes("timeout") || error.includes("ETIMEDOUT")) {
    return "Request timed out. Please try again.";
  }
  return `Something went wrong: ${error.slice(0, 200)}`;
}

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
      "https://smba.trafficmanager.net",
      "https://amer.ng.msg.teams.microsoft.com",
      "https://apac.ng.msg.teams.microsoft.com",
      "https://emea.ng.msg.teams.microsoft.com",
      "https://northamerica.ng.msg.teams.microsoft.com",
      "https://southamerica.ng.msg.teams.microsoft.com",
      "https://europe.ng.msg.teams.microsoft.com",
      "https://asia.ng.msg.teams.microsoft.com",
    ];

    const isValid = validDomains.some((domain) =>
      serviceUrl.startsWith(domain),
    );

    if (!isValid) {
      console.warn(
        `[SECURITY] Rejected request from unknown service: ${serviceUrl}`,
      );
    }

    return isValid;
  }

  private async handleMessage(ctx: TurnContext): Promise<void> {
    // Security: Log request origin (validation handled by Bot Framework JWT)
    if (!this.isValidTeamsRequest(ctx)) {
      console.warn(
        "[SECURITY] Unknown service origin - allowing (JWT already validated by adapter)",
      );
    }

    // Access control check
    if (!this.isUserAllowed(ctx)) {
      await ctx.sendActivity("Sorry, you are not authorized to use this bot.");
      return;
    }

    // Handle Adaptive Card button clicks
    const value = ctx.activity.value as Record<string, unknown> | undefined;
    if (value?.action) {
      const conversationId = ctx.activity.conversation.id;

      if (value.action === "resume_session") {
        const switched = switchToSession(conversationId, value.index as number);
        if (switched) {
          await ctx.sendActivity(
            `🔄 Resumed session\n\n📂 ${switched.workDir}`,
          );
        } else {
          await ctx.sendActivity("Session not found.");
        }
        return;
      }

      if (value.action === "handoff_fork") {
        // Save ref for background use (ctx gets revoked after HTTP response)
        const ref = TurnContext.getConversationReference(ctx.activity);
        const adapter = ctx.adapter as BotFrameworkAdapter;

        // Don't await — run in background so Teams gets HTTP 200 quickly
        adapter
          .continueConversation(ref, async (bgCtx) => {
            await this.handleHandoff(
              bgCtx,
              value.action as string,
              value.workDir as string,
              value.sessionId as string | undefined,
            );
          })
          .catch((err) => console.error("[HANDOFF] Background error:", err));
        return;
      }

      if (
        value.action === "permission_allow" ||
        value.action === "permission_deny"
      ) {
        const toolUseID = value.toolUseID as string;
        const allow = value.action === "permission_allow";
        const resolved = resolvePermission(toolUseID, allow);
        if (resolved) {
          await ctx.sendActivity(allow ? "✅ Allowed" : "❌ Denied");
        } else {
          await ctx.sendActivity("Permission request expired or not found.");
        }
        return;
      }

      if (value.action === "set_permission_mode") {
        const mode = value.mode as string;
        setPermissionMode(conversationId, mode);
        await ctx.sendActivity(`Permission mode set to \`${mode}\``);
        return;
      }

      if (value.action === "prompt_response") {
        const requestId = value.requestId as string;
        const key = value.key as string;
        const resolved = resolvePromptRequest(requestId, key);
        if (resolved) {
          await ctx.sendActivity(`Selected: ${key}`);
        } else {
          await ctx.sendActivity("Prompt request expired or not found.");
        }
        return;
      }

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

    // Run session init prompt on new sessions
    const isNewSession = !getSession(conversationId);
    if (isNewSession && config.sessionInitPrompt) {
      console.log("[BOT] Running session init prompt...");
      const initResult = await runClaude(
        config.sessionInitPrompt,
        undefined,
        getWorkDir(conversationId),
        getModel(conversationId),
        getThinkingTokens(conversationId),
        getPermissionMode(conversationId),
      );
      if (initResult.sessionId) {
        setSession(conversationId, initResult.sessionId);
      }
      if (initResult.error) {
        console.warn(`[BOT] Session init error: ${initResult.error}`);
      }
    }

    // Start typing indicator loop
    const typingController = new AbortController();
    const typingLoop = this.startTypingLoop(ctx, typingController.signal);
    const progress = this.createProgressNotifier(ctx);

    // Build runOptions with permission + prompt handlers
    const permissionMode = getPermissionMode(conversationId);
    const runOptions: RunClaudeOptions = {};

    // Add prompt request handler
    runOptions.onPromptRequest = async (info) => {
      const response = registerPromptRequest(info.requestId);
      const card = createPromptCard(info.requestId, info.message, info.options);
      await ctx.sendActivity({
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: card,
          },
        ],
      });
      return response;
    };

    // Add permission handler (unless bypassing)
    if (permissionMode !== "bypassPermissions") {
      const sendCard = async (req: {
        toolName: string;
        input: Record<string, unknown>;
        toolUseID: string;
        decisionReason?: string;
      }) => {
        const card = buildPermissionCard(
          req.toolName,
          req.input,
          req.toolUseID,
          req.decisionReason,
        );
        void ctx.sendActivity({
          attachments: [
            {
              contentType: "application/vnd.microsoft.card.adaptive",
              content: card,
            },
          ],
        });
      };
      runOptions.canUseTool = createPermissionHandler(sendCard);
    }

    try {
      console.log("[BOT] Calling runClaude...");
      const result = await runClaude(
        text || "What is in this image?",
        getSession(conversationId),
        getWorkDir(conversationId),
        getModel(conversationId),
        getThinkingTokens(conversationId),
        permissionMode,
        images,
        progress.onProgress,
        runOptions,
      );

      console.log("[BOT] runClaude completed, stopping typing");
      // Stop typing
      typingController.abort();
      await typingLoop;

      if (result.error) {
        console.error(`[BOT] Error from Claude: ${result.error}`);
        await progress.finalize([friendlyError(result.error)]);
        return;
      }

      if (result.sessionId) {
        setSession(conversationId, result.sessionId);
      }

      console.log("[BOT] Formatting and sending response");
      await progress.finalize(splitMessage(formatResponse(result)));
      console.log("[BOT] Response sent successfully");
    } catch (err) {
      console.error("[BOT] Error in handleMessage:", err);
      typingController.abort();
      await typingLoop;
      const msg = err instanceof Error ? err.message : String(err);
      await progress.finalize([friendlyError(msg)]);
    }
  }

  /** Handle handoff action — callable from both Adaptive Card clicks and direct API. */
  public async handleHandoff(
    ctx: TurnContext,
    action: string,
    workDir: string,
    sessionId?: string,
  ): Promise<void> {
    const conversationId = ctx.activity.conversation.id;

    if (action === "handoff_fork") {
      // Immediately acknowledge to avoid Teams "something went wrong" timeout
      await ctx.sendActivity(
        `🔄 📂 ${workDir}\n\n⚠️ 完成后请 /handoff 切回，否则两边会各走各的`,
      );

      setHandoffMode(conversationId, "pickup");
      clearSession(conversationId);
      if (workDir) setWorkDir(conversationId, workDir);

      console.log(`[HANDOFF] Fork: sessionId=${sessionId}, workDir=${workDir}`);
      const prompt = `The user handed off from Terminal to Teams (project: ${workDir ?? "unknown"}). Welcome them and ask what they need help with.`;

      await this.runClaudeAndRespond(ctx, conversationId, prompt, undefined, {
        resume: "fork",
      });
    }
  }

  private async runClaudeAndRespond(
    ctx: TurnContext,
    conversationId: string,
    prompt: string,
    images?: ImageInput[],
    runOptions?: RunClaudeOptions,
  ): Promise<void> {
    const typingController = new AbortController();
    const typingLoop = this.startTypingLoop(ctx, typingController.signal);
    const progress = this.createProgressNotifier(ctx);

    // Create permission handler if not bypassing
    const permissionMode = getPermissionMode(conversationId);
    const finalRunOptions = { ...runOptions };

    // Add prompt request handler
    finalRunOptions.onPromptRequest = async (info) => {
      const card = createPromptCard(info.requestId, info.message, info.options);
      await ctx.sendActivity({
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: card,
          },
        ],
      });
      // Wait for user response
      return registerPromptRequest(info.requestId);
    };

    if (permissionMode !== "bypassPermissions") {
      const sendCard = async (req: {
        toolName: string;
        input: Record<string, unknown>;
        toolUseID: string;
        decisionReason?: string;
      }) => {
        const card = buildPermissionCard(
          req.toolName,
          req.input,
          req.toolUseID,
          req.decisionReason,
        );
        await ctx.sendActivity({
          attachments: [
            {
              contentType: "application/vnd.microsoft.card.adaptive",
              content: card,
            },
          ],
        });
      };
      finalRunOptions.canUseTool = createPermissionHandler(sendCard);
    }

    try {
      const result = await runClaude(
        prompt,
        getSession(conversationId),
        getWorkDir(conversationId),
        getModel(conversationId),
        getThinkingTokens(conversationId),
        permissionMode,
        images,
        progress.onProgress,
        finalRunOptions,
      );
      typingController.abort();
      await typingLoop;

      if (result.error) {
        await progress.finalize([friendlyError(result.error)]);
        return;
      }

      if (result.sessionId) {
        setSession(conversationId, result.sessionId);
      }

      await progress.finalize(splitMessage(formatResponse(result)));
    } catch (err) {
      typingController.abort();
      await typingLoop;
      const msg = err instanceof Error ? err.message : String(err);
      await progress.finalize([friendlyError(msg)]);
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
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  }

  private createProgressNotifier(ctx: TurnContext): {
    onProgress: (event: ProgressEvent) => void;
    /** Replace the progress message with final content, or send new if no progress was shown. */
    finalize: (chunks: string[]) => Promise<void>;
  } {
    const MAX_LINES = 10;
    const throttleMs = 2000;
    let activityId: string | undefined;
    let lastSentAt = 0;
    let pendingMessages: string[] = [];
    let timer: NodeJS.Timeout | undefined;
    const progressLines: string[] = [];

    const addLines = (messages: string[]): void => {
      for (const msg of messages) {
        if (progressLines.length >= MAX_LINES) {
          progressLines.shift();
        }
        progressLines.push(msg);
      }
    };

    const updateProgress = async (): Promise<void> => {
      const text = progressLines.join("\n\n");
      if (!text) return;
      try {
        if (!activityId) {
          const resp = await ctx.sendActivity(text);
          activityId = resp?.id;
        } else {
          await ctx.updateActivity({ id: activityId, type: "message", text });
        }
      } catch {
        // Ignore transient update failures.
      }
    };

    const flushPending = async (): Promise<void> => {
      if (pendingMessages.length === 0) return;
      const msgs = pendingMessages;
      pendingMessages = [];
      addLines(msgs);
      lastSentAt = Date.now();
      await updateProgress();
    };

    return {
      onProgress: (event: ProgressEvent) => {
        const message = this.formatProgressMessage(event);
        if (!message) return;

        const now = Date.now();
        const waitMs = throttleMs - (now - lastSentAt);

        if (waitMs <= 0 && !timer) {
          addLines([message]);
          lastSentAt = now;
          void updateProgress();
          return;
        }

        pendingMessages.push(message);
        if (!timer) {
          timer = setTimeout(
            () => {
              timer = undefined;
              void flushPending();
            },
            Math.max(waitMs, 100),
          );
        }
      },
      finalize: async (chunks: string[]) => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (chunks.length === 0) return;
        try {
          if (activityId) {
            await ctx.updateActivity({
              id: activityId,
              type: "message",
              text: chunks[0],
            });
          } else {
            await ctx.sendActivity(chunks[0]);
          }
        } catch {
          await ctx.sendActivity(chunks[0]);
        }
        for (let i = 1; i < chunks.length; i++) {
          await ctx.sendActivity(chunks[i]);
        }
      },
    };
  }

  private formatProgressMessage(event: ProgressEvent): string | undefined {
    if (event.type !== "tool_use") return undefined;
    const tool = event.tool;

    if (tool.name === "Bash") {
      return `🔧 Running: ${this.truncateProgress(tool.command ?? "bash", 100)}`;
    }
    if (tool.name === "Grep") {
      return `🔎 Searching: ${this.truncateProgress(tool.pattern ?? "pattern", 100)}`;
    }
    if (tool.name === "Read") {
      return tool.file
        ? `📖 Reading: ${this.truncateProgress(tool.file, 100)}`
        : "📖 Reading file...";
    }
    if (tool.name === "Edit") {
      return tool.file
        ? `✍️ Editing: ${this.truncateProgress(tool.file, 100)}`
        : "✍️ Editing file...";
    }
    if (tool.name === "Write") {
      return tool.file
        ? `✍️ Writing: ${this.truncateProgress(tool.file, 100)}`
        : "✍️ Writing file...";
    }

    return `🔧 Running: ${tool.name}`;
  }

  private truncateProgress(value: string, max: number): string {
    if (value.length <= max) return value;
    return `${value.slice(0, max - 3)}...`;
  }
}
