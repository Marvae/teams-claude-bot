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
  getSessionCwd,
  setSession,
  setWorkDir,
  getWorkDir,
  getModel,
  getThinkingTokens,
  getPermissionMode,
  setPermissionMode,
  setHandoffMode,
} from "../session/manager.js";
import { type ImageInput, type ProgressEvent } from "../claude/agent.js";
import { ConversationSession, type SessionConfig } from "../claude/session.js";
import * as sessionStore from "../claude/session-store.js";
import type { ManagedSession } from "../claude/session-store.js";
import { formatResponse, splitMessage } from "../claude/formatter.js";
import {
  resolvePermission,
  createPermissionHandler,
} from "../claude/permissions.js";
import {
  buildElicitationFormCard,
  buildElicitationUrlCard,
  buildPermissionCard,
} from "./cards.js";
import { resolveAskUserQuestion } from "../claude/user-questions.js";
import {
  cancelElicitation,
  handleElicitation,
  resolveElicitation,
  resolveElicitationUrlComplete,
} from "../claude/elicitation.js";
import { processAttachments } from "./attachments.js";
import { config } from "../config.js";
import { saveConversationRef } from "../handoff/store.js";

function friendlyError(error: string, stopReason?: string | null): string {
  if (stopReason === "refusal") {
    return "Claude declined this request.";
  }
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
  private permissionCards = new Map<
    string,
    {
      activityId: string;
      toolName: string;
      input: Record<string, unknown>;
      decisionReason?: string;
    }
  >();

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
        const sessionId = value.sessionId as string;
        if (sessionId) {
          const cwd = value.cwd as string | undefined;
          // Destroy existing streaming session so next message starts fresh
          sessionStore.destroy(conversationId);
          setSession(conversationId, sessionId, cwd);
          const dirLabel = cwd ? `\n\n📂 ${cwd}` : "";
          await ctx.sendActivity(
            `🔄 Resumed session \`${sessionId.slice(0, 8)}…\`${dirLabel}`,
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
        const label = allow ? "✅ Allowed" : "❌ Denied";

        const cardInfo = this.permissionCards.get(toolUseID);
        this.permissionCards.delete(toolUseID);

        if (cardInfo) {
          const updatedCard = buildPermissionCard(
            cardInfo.toolName,
            cardInfo.input,
            toolUseID,
            cardInfo.decisionReason,
            resolved ? label : "⏰ Expired",
          );
          try {
            await ctx.updateActivity({
              id: cardInfo.activityId,
              type: "message",
              attachments: [
                {
                  contentType: "application/vnd.microsoft.card.adaptive",
                  content: updatedCard,
                },
              ],
            });
          } catch {
            await ctx.sendActivity(
              resolved ? label : "Permission request expired or not found.",
            );
          }
        } else {
          await ctx.sendActivity(
            resolved ? label : "Permission request expired or not found.",
          );
        }
        return;
      }

      if (value.action === "ask_user_question_submit") {
        const toolUseID = value.toolUseID as string;
        const resolved = resolveAskUserQuestion(toolUseID, value);
        if (resolved) {
          await ctx.sendActivity("✅ Submitted");
        } else {
          await ctx.sendActivity("Question request expired or not found.");
        }
        return;
      }

      if (value.action === "elicitation_form_submit") {
        const elicitationId = value.elicitationId as string;
        const resolved = resolveElicitation(elicitationId, value);
        if (resolved) {
          await ctx.sendActivity("✅ Submitted");
        } else {
          await ctx.sendActivity("Elicitation request expired or not found.");
        }
        return;
      }

      if (value.action === "elicitation_url_complete") {
        const elicitationId = value.elicitationId as string;
        const resolved = resolveElicitationUrlComplete(elicitationId);
        if (resolved) {
          await ctx.sendActivity("✅ Authorization confirmed");
        } else {
          await ctx.sendActivity("Elicitation request expired or not found.");
        }
        return;
      }

      if (value.action === "elicitation_form_cancel") {
        const elicitationId = value.elicitationId as string;
        const resolved = cancelElicitation(elicitationId);
        if (resolved) {
          await ctx.sendActivity("❌ Canceled");
        } else {
          await ctx.sendActivity("Elicitation request expired or not found.");
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

    // Get or create the managed session (single lookup)
    const managed = sessionStore.getOrCreate(conversationId, () =>
      this.createManagedSession(conversationId),
    );

    if (managed.session.isBusy) {
      managed.pendingMessages.push({ text: text || "What is in this image?", images });
      console.log(
        `[BOT] Message queued (${managed.pendingMessages.length} pending) for ${conversationId}`,
      );
      await ctx.sendActivity(
        `⏳ Queued (${managed.pendingMessages.length}) — will process after the current task. Send \`/stop\` to cancel.`,
      );
      return;
    }

    // Update ctx reference for this turn (so callbacks can send cards)
    managed.setCtx(ctx);

    // Process current message, then drain any queued messages
    await this.processUserMessage(
      managed,
      conversationId,
      ctx,
      text || "What is in this image?",
      images,
    );

    // Drain pending messages that arrived while we were busy
    while (managed.pendingMessages.length > 0) {
      const next = managed.pendingMessages.shift()!;
      console.log(`[BOT] Processing queued message for ${conversationId}`);
      await this.processUserMessage(
        managed,
        conversationId,
        ctx,
        next.text,
        next.images,
      );
    }
  }

  private async processUserMessage(
    managed: ManagedSession,
    conversationId: string,
    ctx: TurnContext,
    text: string,
    images?: ImageInput[],
  ): Promise<void> {
    // Run init prompt on new sessions (first send starts the query)
    if (!managed.session.hasQuery && config.sessionInitPrompt) {
      console.log("[BOT] Running session init prompt...");
      const initResult = await managed.session.send(config.sessionInitPrompt);
      if (initResult.error) {
        console.warn(`[BOT] Session init error: ${initResult.error}`);
      }
    }

    // Start typing indicator loop
    const typingController = new AbortController();
    const typingLoop = this.startTypingLoop(ctx, typingController.signal);
    const progress = this.createProgressNotifier(ctx, typingController);

    try {
      console.log("[BOT] Sending message to session...");
      const result = await managed.session.send(text, {
        onProgress: progress.onProgress,
        images,
      });

      console.log("[BOT] Session turn completed, stopping typing");
      typingController.abort();
      await typingLoop;

      if (result.error) {
        console.error(`[BOT] Error from session: ${result.error}`);
        sessionStore.destroy(conversationId);
        await progress.finalize([
          friendlyError(result.error, result.stopReason),
        ]);
        return;
      }

      if (result.interrupted) {
        console.log("[BOT] Turn was interrupted");
        const parts: string[] = ["🛑 Interrupted."];
        if (result.result) {
          parts.push(result.result);
        }
        await progress.finalize(splitMessage(parts.join("\n\n")));
        return;
      }

      console.log("[BOT] Formatting and sending response");
      await progress.finalize(splitMessage(formatResponse(result)));
      console.log("[BOT] Response sent successfully");
    } catch (err) {
      console.error("[BOT] Error in handleMessage:", err);
      typingController.abort();
      await typingLoop;
      sessionStore.destroy(conversationId);
      const msg = err instanceof Error ? err.message : String(err);
      await progress.finalize([friendlyError(msg)]);
    }
  }

  /** Create a ManagedSession for a conversation with all callbacks wired up. */
  private createManagedSession(
    conversationId: string,
    overrides?: { resume?: string; forkSession?: boolean },
  ): ManagedSession {
    // Mutable ctx reference — updated before each send()
    let currentCtx: TurnContext;

    const sendActivity = async (
      activity: Partial<{
        attachments: unknown[];
        type: string;
        text: string;
      }>,
    ) => {
      return currentCtx?.sendActivity(
        activity as Parameters<TurnContext["sendActivity"]>[0],
      );
    };

    const sendCard = async (card: Record<string, unknown>) => {
      await sendActivity({
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: card,
          },
        ],
      });
    };

    // Permission handler
    const sendPermCard = async (req: {
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
      const resp = await sendActivity({
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: card,
          },
        ],
      });
      if (resp?.id) {
        this.permissionCards.set(req.toolUseID, {
          activityId: resp.id,
          toolName: req.toolName,
          input: req.input,
          decisionReason: req.decisionReason,
        });
      }
    };

    // Elicitation handler
    const onElicitation = async (
      request: Parameters<typeof handleElicitation>[0],
    ) => {
      return handleElicitation(request, async (elicitationId, req) => {
        const card =
          req.mode === "url"
            ? buildElicitationUrlCard(elicitationId, req)
            : buildElicitationFormCard(elicitationId, req);
        await sendCard(card);
      });
    };

    // Prompt request handler
    const onPromptRequest = async (info: {
      requestId: string;
      message: string;
      options: unknown[];
    }) => {
      const response = registerPromptRequest(info.requestId);
      await sendCard(
        createPromptCard(
          info.requestId,
          info.message,
          info.options as Parameters<typeof createPromptCard>[2],
        ),
      );
      return response;
    };

    const cwd = getSessionCwd(conversationId) ?? getWorkDir(conversationId);

    const sessionConfig: SessionConfig = {
      cwd,
      model: getModel(conversationId),
      thinkingTokens: getThinkingTokens(conversationId),
      permissionMode: getPermissionMode(conversationId),
      resume: overrides?.resume,
      forkSession: overrides?.forkSession,
      continue: !overrides?.resume,
      canUseTool: createPermissionHandler(sendPermCard),
      onElicitation,
      onPromptRequest,
      onSessionId: (id) => {
        setSession(conversationId, id, cwd);
      },
    };

    const session = new ConversationSession(sessionConfig);

    return {
      session,
      setCtx: (ctx: unknown) => {
        currentCtx = ctx as TurnContext;
      },
      pendingMessages: [],
    };
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
      // Destroy existing session so we start fresh
      sessionStore.destroy(conversationId);
      clearSession(conversationId);
      if (workDir) setWorkDir(conversationId, workDir);

      console.log(`[HANDOFF] Fork: sessionId=${sessionId}, workDir=${workDir}`);

      // Create session — if we have a terminal sessionId, resume+fork it
      // so Claude gets the full conversation history automatically
      const managed = sessionStore.getOrCreate(conversationId, () =>
        this.createManagedSession(conversationId, {
          resume: sessionId,
          forkSession: !!sessionId,
        }),
      );
      managed.setCtx(ctx);

      const prompt = sessionId
        ? `The user handed off from Terminal to Teams (project: ${workDir ?? "unknown"}). You have the full terminal conversation history. Welcome them briefly, summarize what was being worked on, and ask what they need help with. Reply in the same language as the conversation above.`
        : `The user started a new session from Teams (project: ${workDir ?? "unknown"}). Welcome them briefly and ask what they need help with.`;

      const typingController = new AbortController();
      const typingLoop = this.startTypingLoop(ctx, typingController.signal);
      const progress = this.createProgressNotifier(ctx, typingController);

      try {
        const result = await managed.session.send(prompt);
        typingController.abort();
        await typingLoop;

        if (result.error) {
          await progress.finalize([
            friendlyError(result.error, result.stopReason),
          ]);
          return;
        }

        await progress.finalize(splitMessage(formatResponse(result)));
      } catch (err) {
        typingController.abort();
        await typingLoop;
        const msg = err instanceof Error ? err.message : String(err);
        await progress.finalize([friendlyError(msg)]);
      }
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

  createProgressNotifier(
    ctx: TurnContext,
    typingController?: AbortController,
  ): {
    onProgress: (event: ProgressEvent) => void;
    /** Replace the progress message with final content, or send new if no progress was shown. */
    finalize: (chunks: string[]) => Promise<void>;
  } {
    const MAX_LINES = 10;
    const TOOL_THROTTLE_MS = 2000;
    const TEXT_THROTTLE_MS = 1000;
    const MAX_STREAMING_LEN = 4000; // Keep streaming preview short
    let activityId: string | undefined;
    let lastSentAt = 0;
    let timer: NodeJS.Timeout | undefined;
    let inflightUpdate: Promise<void> | undefined;
    const progressLines: string[] = [];
    let streamingText: string | undefined;
    let pendingUpdate = false;

    const buildDisplay = (): string => {
      const parts: string[] = [];
      if (progressLines.length > 0) {
        parts.push(progressLines.join("\n\n"));
      }
      if (streamingText) {
        if (parts.length > 0) parts.push("---");
        const display =
          streamingText.length > MAX_STREAMING_LEN
            ? "…" + streamingText.slice(-MAX_STREAMING_LEN)
            : streamingText;
        parts.push(display);
      }
      return parts.join("\n\n");
    };

    const sendUpdate = async (): Promise<void> => {
      // Serialize: wait for any previous sendUpdate to finish first
      if (inflightUpdate) {
        await inflightUpdate;
      }
      const text = buildDisplay();
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

    const scheduleUpdate = (throttleMs: number): void => {
      const now = Date.now();
      const waitMs = throttleMs - (now - lastSentAt);

      if (waitMs <= 0 && !timer) {
        lastSentAt = now;
        inflightUpdate = sendUpdate();
        return;
      }

      pendingUpdate = true;
      if (!timer) {
        timer = setTimeout(
          () => {
            timer = undefined;
            if (pendingUpdate) {
              pendingUpdate = false;
              lastSentAt = Date.now();
              inflightUpdate = sendUpdate();
            }
          },
          Math.max(waitMs, 100),
        );
      }
    };

    return {
      onProgress: (event: ProgressEvent) => {
        if (event.type === "done") {
          typingController?.abort();
          return;
        }

        if (event.type === "text") {
          streamingText = event.text;
          scheduleUpdate(TEXT_THROTTLE_MS);
          return;
        }

        const message = this.formatProgressMessage(event);
        if (!message) return;
        if (progressLines.length >= MAX_LINES) {
          progressLines.shift();
        }
        progressLines.push(message);
        // Clear streaming text when new tool starts (Claude is doing tool work)
        streamingText = undefined;
        scheduleUpdate(TOOL_THROTTLE_MS);
      },
      finalize: async (chunks: string[]) => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        // Wait for any in-flight sendUpdate to complete (sets activityId)
        if (inflightUpdate) {
          await inflightUpdate;
          inflightUpdate = undefined;
        }
        if (chunks.length === 0) return;

        // First chunk: update existing message or send new
        if (activityId) {
          try {
            await ctx.updateActivity({
              id: activityId,
              type: "message",
              text: chunks[0],
            });
          } catch {
            // updateActivity failed — message already shows streaming content,
            // don't send a duplicate
          }
        } else {
          await ctx.sendActivity(chunks[0]);
        }

        // Additional chunks as separate messages
        for (let i = 1; i < chunks.length; i++) {
          await ctx.sendActivity(chunks[i]);
        }
      },
    };
  }

  private formatProgressMessage(event: ProgressEvent): string | undefined {
    if (event.type === "tool_summary") {
      return `📋 ${this.truncateProgress(event.summary, 200)}`;
    }

    if (event.type === "task_status") {
      const icon =
        event.status === "started"
          ? "🚀"
          : event.status === "completed"
            ? "✅"
            : "⚠️";
      return `${icon} Task: ${this.truncateProgress(event.summary, 150)}`;
    }

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
