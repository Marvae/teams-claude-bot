import {
  resolvePromptRequest,
  createPromptCard,
  registerPromptRequest,
} from "../claude/user-input.js";
import { ActivityHandler, BotFrameworkAdapter, TurnContext } from "botbuilder";
import { stripMention } from "./mention.js";
import { handleCommand } from "./commands.js";
import * as state from "../session/state.js";
import {
  type ClaudeResult,
  type ProgressEvent,
} from "../claude/agent.js";
import { ConversationSession, type SessionConfig } from "../claude/session.js";
import { formatResponse, splitMessage } from "../claude/formatter.js";
import {
  resolvePermission,
  resolvePermissionWithSuggestion,
  createToolInterceptor,
} from "../claude/tool-interceptor.js";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import {
  buildElicitationFormCard,
  buildElicitationUrlCard,
  buildHandoffCard,
  buildToolCard,
} from "./cards.js";
import { resolveAskUserQuestion } from "../claude/user-questions.js";
import {
  cancelElicitation,
  handleElicitation,
  resolveElicitation,
  resolveElicitationUrlComplete,
} from "../claude/elicitation.js";
import { processAttachments, filterPlatformAttachments, type ContentBlock } from "./attachments.js";
import { config } from "../config.js";
import { saveConversationRef } from "../handoff/store.js";

// Maps file extensions to Teams CodeBlock language names (only where they differ).
// Extensions that already match (e.g. go, java, json, xml, css, sql, php, perl,
// swift, rust, ruby, dart, scala, kotlin, scss, jsx, r, graphql) need no entry.
const EXT_LANG_OVERRIDE: Record<string, string> = {
  ts: "typescript", tsx: "typescript",
  js: "javascript", mjs: "javascript",
  py: "python",
  sh: "bash", zsh: "bash",
  cs: "csharp",
  cc: "cpp", cxx: "cpp", hpp: "cpp",
  htm: "html",
  ps1: "powershell",
  kt: "kotlin",
  tex: "latex",
  yml: "yaml",
  m: "objective-c",
  mm: "objective-c",
  vb: "vb.net",
  vbs: "vbscript",
  v: "verilog",
  vhd: "vhdl",
  md: "markdown",
};

function codeBlockLanguage(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return "plaintext";
  const ext = filePath.slice(dot + 1).toLowerCase();
  return EXT_LANG_OVERRIDE[ext] ?? ext;
}

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
  if (
    error.includes("auth") ||
    error.includes("unauthorized") ||
    error.includes("login") ||
    error.includes("credential") ||
    error.includes("OAuth")
  ) {
    return "Claude login expired. Run `claude login` in your terminal, then try again.";
  }
  if (error.includes("rate_limit") || error.includes("429")) {
    return "Claude API is rate limited. Please wait a moment and try again.";
  }
  if (error.includes("context_length")) {
    return "Conversation is too long. Use `/new` to start a fresh session.";
  }
  if (error.includes("timeout") || error.includes("ETIMEDOUT")) {
    return "Request timed out. Please try again.";
  }
  if (error.includes("max_turns")) {
    return "This task used too many steps. Try breaking it into smaller requests, or use `/new` to start fresh.";
  }
  if (
    error.includes("request_too_large") ||
    error.includes("Could not process image") ||
    error.includes("image exceeds")
  ) {
    return "The file you sent is too large for the API. Try a smaller file, or send it as text.";
  }
  if (error.includes("invalid_request") && error.includes("image")) {
    return "The image format is not supported. Supported formats: JPEG, PNG, GIF, WebP.";
  }
  return `Something went wrong: ${error.slice(0, 200)}`;
}

export class ClaudeCodeBot extends ActivityHandler {
  private interactiveCards = new Map<
    string,
    {
      toolName: string;
      input: Record<string, unknown>;
      decisionReason?: string;
      suggestions?: PermissionUpdate[];
      activityId: string;
    }
  >();

  /** Dedup: track recently processed activity IDs to ignore Teams duplicate webhooks. */
  private processedActivities = new Map<string, number>();

  constructor() {
    super();
    this.onMessage(async (ctx, next) => {
      // Deduplicate: Teams sometimes sends the same message twice
      const activityId = ctx.activity.id;
      if (activityId && this.processedActivities.has(activityId)) {
        console.log(`[BOT] Ignoring duplicate activity: ${activityId}`);
        await next();
        return;
      }
      if (activityId) {
        this.processedActivities.set(activityId, Date.now());
        if (this.processedActivities.size > 100) {
          const cutoff = Date.now() - 60_000;
          for (const [id, ts] of this.processedActivities) {
            if (ts < cutoff) this.processedActivities.delete(id);
          }
        }
      }

      saveConversationRef(ctx);
      await this.handleMessage(ctx);
      await next();
    });

    // Save conversation ref on bot install so /handoff works without prior messages
    this.onInstallationUpdate(async (ctx, next) => {
      saveConversationRef(ctx);
      console.log("[BOT] Installation update — conversation ref saved");
      await next();
    });

    this.onMembersAdded(async (ctx, next) => {
      saveConversationRef(ctx);
      console.log("[BOT] Members added — conversation ref saved");
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
    const serviceUrl = ctx.activity.serviceUrl;
    if (!serviceUrl) return false;

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
    if (!this.isValidTeamsRequest(ctx)) {
      console.warn(
        "[SECURITY] Unknown service origin - allowing (JWT already validated by adapter)",
      );
    }

    if (!this.isUserAllowed(ctx)) {
      await ctx.sendActivity("Sorry, you are not authorized to use this bot.");
      return;
    }

    // Handle Adaptive Card button clicks
    const value = ctx.activity.value as Record<string, unknown> | undefined;
    if (value?.action) {
      // Helper: delete the card that triggered this submit action
      const deleteSubmittedCard = async () => {
        try {
          const cardId = ctx.activity.replyToId;
          if (cardId) await ctx.deleteActivity(cardId);
        } catch { /* card may already be gone */ }
      };

      if (value.action === "resume_session") {
        const sessionId = value.sessionId as string;
        if (sessionId) {
          const currentId = state.getSession()?.session.currentSessionId;
          if (sessionId === currentId) {
            await deleteSubmittedCard();
            await ctx.sendActivity("That session is already active.");
            return;
          }
          // cwd comes from the sessionCwds lookup embedded in the card data
          const sessionCwds = value.sessionCwds as
            | Record<string, string | undefined>
            | undefined;
          const cwd =
            sessionCwds?.[sessionId] ?? (value.cwd as string | undefined);
          if (cwd) {
            const r = state.setWorkDir(cwd);
            if (!r.ok) {
              await ctx.sendActivity(
                `Cannot resume — \`${cwd}\` is outside the allowed work directory.`,
              );
              return;
            }
          }
          await deleteSubmittedCard();
          state.destroySession();
          state.persistSessionId(sessionId);
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
        await deleteSubmittedCard();
        // Show confirmation card — don't switch yet
        const card = buildHandoffCard(
          value.workDir as string,
          value.sessionId as string | undefined,
        );
        await ctx.sendActivity({
          attachments: [
            {
              contentType: "application/vnd.microsoft.card.adaptive",
              content: card,
            },
          ],
        });
        return;
      }

      if (value.action === "handoff_accept") {
        // Replace card buttons with "✅ Handed off" text
        const cardActivityId = ctx.activity.replyToId;
        if (cardActivityId) {
          try {
            const updatedCard = buildHandoffCard(
              value.workDir as string,
              value.sessionId as string | undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              "✅ Handed off",
            );
            await ctx.updateActivity({
              id: cardActivityId,
              type: "message",
              attachments: [
                {
                  contentType: "application/vnd.microsoft.card.adaptive",
                  content: updatedCard,
                },
              ],
            });
          } catch { /* card may be gone */ }
        }

        // User confirmed — do the actual handoff in background
        const ref = TurnContext.getConversationReference(ctx.activity);
        const adapter = ctx.adapter as BotFrameworkAdapter;

        adapter
          .continueConversation(ref, async (bgCtx) => {
            await this.handleHandoff(
              bgCtx,
              "handoff_accept",
              value.workDir as string,
              value.sessionId as string | undefined,
            );
          })
          .catch((err) => console.error("[HANDOFF] Background error:", err));
        return;
      }

      if (value.action === "permission_decision") {
        const toolUseID = value.toolUseID as string;
        const choice = (value.permissionChoice as string) ?? "deny";

        if (choice.startsWith("suggestion_")) {
          const idx = parseInt(choice.replace("suggestion_", ""), 10);
          resolvePermissionWithSuggestion(toolUseID, idx);
        } else {
          resolvePermission(toolUseID, choice === "allow");
        }

        const cardInfo = this.interactiveCards.get(toolUseID);
        this.interactiveCards.delete(toolUseID);

        if (cardInfo) {
          try {
            await ctx.deleteActivity(cardInfo.activityId);
          } catch {
            // Card may already be deleted by timeout handler
          }
        }
        return;
      }

      // Legacy: support old permission_allow/deny actions for in-flight cards
      if (
        value.action === "permission_allow" ||
        value.action === "permission_deny" ||
        value.action === "permission_allow_session"
      ) {
        const toolUseID = value.toolUseID as string;
        const allow = value.action !== "permission_deny";
        if (value.action === "permission_allow_session") {
          resolvePermissionWithSuggestion(
            toolUseID,
            value.suggestionIndex as number,
          );
        } else {
          resolvePermission(toolUseID, allow);
        }
        const cardInfo = this.interactiveCards.get(toolUseID);
        this.interactiveCards.delete(toolUseID);

        if (cardInfo) {
          try {
            await ctx.deleteActivity(cardInfo.activityId);
          } catch {
            // Card may already be deleted by timeout handler
          }
        }
        return;
      }

      if (value.action === "ask_user_question_submit") {
        const toolUseID = value.toolUseID as string;
        const resolved = resolveAskUserQuestion(toolUseID, value);
        const cardInfo = this.interactiveCards.get(toolUseID);
        this.interactiveCards.delete(toolUseID);
        if (cardInfo) {
          try {
            await ctx.deleteActivity(cardInfo.activityId);
          } catch {
            // Card may already be deleted
          }
        }
        if (!resolved) {
          await ctx.sendActivity("Question request expired or not found.");
        }
        return;
      }

      if (value.action === "elicitation_form_submit") {
        const elicitationId = value.elicitationId as string;
        const resolved = resolveElicitation(elicitationId, value);
        this.interactiveCards.delete(elicitationId);
        await deleteSubmittedCard();
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
        this.interactiveCards.delete(elicitationId);
        await deleteSubmittedCard();
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
        this.interactiveCards.delete(elicitationId);
        await deleteSubmittedCard();
        if (resolved) {
          await ctx.sendActivity("❌ Canceled");
        } else {
          await ctx.sendActivity("Elicitation request expired or not found.");
        }
        return;
      }

      if (value.action === "set_permission_mode") {
        const mode = value.mode as string;
        state.setPermissionMode(mode);
        await state.getSession()?.session.setPermissionMode(mode);
        await deleteSubmittedCard();
        await ctx.sendActivity(`Permission mode set to \`${mode}\``);
        return;
      }

      if (value.action === "prompt_response") {
        const requestId = value.requestId as string;
        const key = value.key as string;
        const resolved = resolvePromptRequest(requestId, key);
        this.interactiveCards.delete(requestId);
        await deleteSubmittedCard();
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

    // Process attachments — images/PDFs as inline content blocks, others saved to tmp
    const rawAttachments = ctx.activity.attachments
      ? filterPlatformAttachments(ctx.activity.attachments)
      : undefined;
    let inlineBlocks: ContentBlock[] = [];
    if (rawAttachments && rawAttachments.length > 0) {
      const { contentBlocks, savedFiles, failed } = await processAttachments(
        ctx,
        rawAttachments,
      );
      inlineBlocks = contentBlocks;
      if (savedFiles.length > 0) {
        const fileRefs = savedFiles
          .map((p) => `[Uploaded file: ${p}]`)
          .join("\n");
        text =
          `The user sent the following file(s). Use the Read tool to view them:\n${fileRefs}\n\n` +
          text;
      }
      if (failed.length > 0) {
        await ctx.sendActivity(
          `Failed to download: ${failed.join(", ")}`,
        );
      }
    }

    if (!text && inlineBlocks.length === 0) return;

    // Strip @mention in group chats
    text = stripMention(text);
    if (!text && inlineBlocks.length === 0) return;

    // Handle slash commands
    if (await handleCommand(text, ctx)) return;

    // Get or create the managed session
    let managed = state.getSession();
    if (!managed) {
      managed = this.createManagedSession();
      state.setSession(managed);
    }

    // Save conversation ref for proactive messaging (survives after handler returns)
    managed.setRef(ctx);

    // Run init prompt on new sessions (first send starts the query)
    if (!managed.session.hasQuery && config.sessionInitPrompt) {
      console.log("[BOT] Running session init prompt...");
      managed.session.send(config.sessionInitPrompt);
    }

    // Show typing indicator immediately so the user knows the bot is working
    await ctx.sendActivity({
      type: "typing",
      channelData: { streamType: "informative" },
    });

    // Fire and forget — replies sent via continueConversation in onResult
    console.log("[BOT] Sending message to session...");
    if (inlineBlocks.length > 0) {
      // Build content block array: inline images/PDFs + text
      const content: ContentBlock[] = [
        ...inlineBlocks,
        ...(text ? [{ type: "text" as const, text }] : []),
      ];
      managed.session.send(content);
    } else {
      managed.session.send(text);
    }
  }

  /** Create a ManagedSession with all callbacks wired up. */
  private createManagedSession(overrides?: {
    resume?: string;
    forkSession?: boolean;
    cwd?: string;
  }): state.ManagedSession {
    let conversationRef: Partial<
      import("botbuilder").ConversationReference
    > | null = null;
    let adapter: BotFrameworkAdapter | null = null;

    // Proactive sendActivity — works after handleMessage returns
    const sendActivity = async (activity: Record<string, unknown>) => {
      if (!conversationRef || !adapter) return undefined;
      let result: { id?: string } | undefined;
      await adapter.continueConversation(conversationRef, async (ctx) => {
        const resp = await ctx.sendActivity(
          activity as Parameters<TurnContext["sendActivity"]>[0],
        );
        result = resp ? { id: resp.id } : undefined;
      });
      return result;
    };

    // Proactive updateActivity — update an existing message by id
    const updateActivity = async (
      activityId: string,
      activity: Record<string, unknown>,
    ) => {
      if (!conversationRef || !adapter) return;
      await adapter.continueConversation(conversationRef, async (ctx) => {
        await ctx.updateActivity({
          ...activity,
          id: activityId,
          conversation: ctx.activity.conversation,
        } as Parameters<TurnContext["updateActivity"]>[0]);
      });
    };

    // Proactive deleteActivity — delete a message by id
    const deleteActivity = async (activityId: string) => {
      if (!conversationRef || !adapter) return;
      await adapter.continueConversation(conversationRef, async (ctx) => {
        await ctx.deleteActivity(activityId);
      });
    };

    const sendCard = async (card: Record<string, unknown>): Promise<string | undefined> => {
      const resp = await sendActivity({
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: card,
          },
        ],
      });
      return resp?.id;
    };

    const sendToolCard = async (req: {
      toolName: string;
      input: Record<string, unknown>;
      toolUseID: string;
      decisionReason?: string;
      suggestions?: PermissionUpdate[];
    }) => {
      const card = buildToolCard(
        req.toolName,
        req.input,
        req.toolUseID,
        req.decisionReason,
        req.suggestions,
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
        this.interactiveCards.set(req.toolUseID, {
          toolName: req.toolName,
          input: req.input,
          decisionReason: req.decisionReason,
          suggestions: req.suggestions,
          activityId: resp.id,
        });
      }
    };

    const onElicitation = async (
      request: Parameters<typeof handleElicitation>[0],
    ) => {
      return handleElicitation(
        request,
        async (elicitationId, req) => {
          const card =
            req.mode === "url"
              ? buildElicitationUrlCard(elicitationId, req)
              : buildElicitationFormCard(elicitationId, req);
          const activityId = await sendCard(card);
          if (activityId) {
            this.interactiveCards.set(elicitationId, {
              toolName: "Elicitation",
              input: {},
              activityId,
            });
          }
        },
        {
          timeoutMs: 120_000,
          onTimeout: async (elicitationId: string) => {
            const cardInfo = this.interactiveCards.get(elicitationId);
            this.interactiveCards.delete(elicitationId);
            if (cardInfo) {
              try { await deleteActivity(cardInfo.activityId); } catch { /* ignore */ }
            }
            await sendActivity({ type: "message", text: "⏰ Elicitation timed out." });
          },
        },
      );
    };

    const onPromptRequest = async (info: {
      requestId: string;
      message: string;
      options: unknown[];
    }) => {
      const response = registerPromptRequest(info.requestId, {
        onTimeout: async (requestId: string) => {
          const cardInfo = this.interactiveCards.get(requestId);
          this.interactiveCards.delete(requestId);
          if (cardInfo) {
            try { await deleteActivity(cardInfo.activityId); } catch { /* ignore */ }
          }
          await sendActivity({ type: "message", text: "⏰ Prompt request timed out." });
        },
      });
      const activityId = await sendCard(
        createPromptCard(
          info.requestId,
          info.message,
          info.options as Parameters<typeof createPromptCard>[2],
        ),
      );
      if (activityId) {
        this.interactiveCards.set(info.requestId, {
          toolName: "PromptRequest",
          input: {},
          activityId,
        });
      }
      return response;
    };

    const cwd = overrides?.cwd ?? state.getWorkDir();
    const savedId = state.loadPersistedSessionId();

    // Auto-managed progress — created on first event, destroyed on result
    let currentProgress: ReturnType<
      typeof ClaudeCodeBot.prototype.createProgressNotifier
    > | null = null;

    const sessionConfig: SessionConfig = {
      cwd,
      model: state.getModel(),
      thinkingTokens: state.getThinkingTokens(),
      permissionMode: state.getPermissionMode(),
      resume: overrides?.resume ?? savedId,
      forkSession: overrides?.forkSession,
      canUseTool: createToolInterceptor(sendToolCard, {
        onTimeout: async (toolUseID) => {
          const cardInfo = this.interactiveCards.get(toolUseID);
          this.interactiveCards.delete(toolUseID);
          if (cardInfo) {
            try {
              await deleteActivity(cardInfo.activityId);
            } catch {
              // ignore
            }
          }
        },
      }),
      onElicitation,
      onPromptRequest,
      onSessionId: (id) => {
        state.persistSessionId(id);
        // Cache SDK commands on first init (fire-and-forget)
        setTimeout(async () => {
          try {
            const managed = state.getSession();
            const cmds = await managed?.session.getSupportedCommands();
            if (cmds && cmds.length > 0) {
              state.setCachedCommands(cmds);
            }
          } catch {
            // Ignore — commands will be fetched on next /help
          }
        }, 1000);
      },
      onResumeInvalid: async () => {
        state.clearPersistedSessionId();
        await sendActivity({
          type: "message",
          text: "Previous session could not be resumed. Retrying with a fresh session in the same project...",
        });
      },
      onProgress: (event: ProgressEvent) => {
        if (!currentProgress) {
          currentProgress = this.createProgressNotifier(
            sendActivity,
            updateActivity,
          );
        }
        currentProgress.onProgress(event);
      },
      onResult: async (result: ClaudeResult) => {
        if (!currentProgress) {
          currentProgress = this.createProgressNotifier(
            sendActivity,
            updateActivity,
          );
        }
        const progress = currentProgress;
        currentProgress = null;

        state.addUsage(result.costUsd, result.usage);

        if (result.error) {
          console.error(`[BOT] Error from session: ${result.error}`);
          await progress.finalize([
            friendlyError(result.error, result.stopReason),
          ]);
          return;
        }

        if (result.interrupted) {
          console.log("[BOT] Turn was interrupted");
          if (result.result) {
            await progress.finalize(splitMessage(result.result));
          }
          return;
        }

        console.log("[BOT] Formatting and sending response");
        await progress.finalize(splitMessage(formatResponse(result)));

        // Send prompt suggestion as quick-reply button
        const suggestion = progress.getPromptSuggestion();
        if (suggestion) {
          try {
            await sendActivity({
              type: "message",
              text: "",
              suggestedActions: {
                to: [],
                actions: [
                  { type: "imBack", title: suggestion, value: suggestion },
                ],
              },
            });
          } catch {
            // suggestedActions not supported — skip
          }
        }

        console.log("[BOT] Response sent successfully");
      },
    };

    const session = new ConversationSession(sessionConfig);

    return {
      session,
      setRef: (ctx: unknown) => {
        const tc = ctx as TurnContext;
        conversationRef = TurnContext.getConversationReference(tc.activity);
        adapter = tc.adapter as BotFrameworkAdapter;
      },
    };
  }

  /** Handle handoff action. */
  public async handleHandoff(
    ctx: TurnContext,
    action: string,
    workDir: string,
    sessionId?: string,
  ): Promise<void> {
    if (action === "handoff_accept") {
      // Validate path before making any state changes
      if (workDir) {
        const r = state.setWorkDir(workDir);
        if (!r.ok) {
          await ctx.sendActivity(`⚠️ Handoff rejected — ${r.error}`);
          return;
        }
      }

      state.setHandoffMode("pickup");
      state.destroySession();
      state.clearPersistedSessionId();

      await ctx.sendActivity(
        `🔄 Session handed off to Teams\n📂 \`${workDir}\`\n\nWhen you're done, use \`/handoff back\` to return control to Terminal.`,
      );

      console.log(`[HANDOFF] Fork: sessionId=${sessionId}, workDir=${workDir}`);

      const managed = this.createManagedSession({
        resume: sessionId,
        forkSession: !!sessionId,
        cwd: state.getWorkDir(),
      });
      state.setSession(managed);
      managed.setRef(ctx);

      const prompt = sessionId
        ? `The user handed off from Terminal to Teams (project: ${workDir ?? "unknown"}). You have the full terminal conversation history. Greet them and let them know you're ready to continue. Reply in the same language as the conversation above.`
        : `The user started a new session from Teams (project: ${workDir ?? "unknown"}). Welcome them briefly and ask what they need help with.`;

      // Fire and forget — reply sent via onResult callback
      managed.session.send(prompt);
    }
  }

  createProgressNotifier(
    sendFn: (
      activity: Record<string, unknown>,
    ) => Promise<{ id?: string } | undefined>,
    updateFn: (
      activityId: string,
      activity: Record<string, unknown>,
    ) => Promise<void>,
  ): {
    onProgress: (event: ProgressEvent) => void;
    finalize: (chunks: string[]) => Promise<void>;
    getPromptSuggestion: () => string | undefined;
  } {
    const TOOL_THROTTLE_MS = 2000;
    const TEXT_THROTTLE_MS = 1000;
    const MAX_STREAMING_LEN = 4000;
    let lastSentAt = 0;
    let timer: NodeJS.Timeout | undefined;
    let inflightUpdate: Promise<void> | undefined;
    let completedText = "";
    let streamingText: string | undefined;
    let todoDisplay: string | undefined;
    let pendingUpdate = false;
    let promptSuggestion: string | undefined;
    let streamingActivityId: string | undefined;
    let useHtml = false;
    const buildDisplay = (): string => {
      const parts: string[] = [];
      if (todoDisplay) {
        parts.push(todoDisplay);
      }
      const fullText = completedText + (streamingText ?? "");
      if (fullText) {
        if (parts.length > 0) parts.push("---");
        let display =
          fullText.length > MAX_STREAMING_LEN
            ? "…" + fullText.slice(-MAX_STREAMING_LEN)
            : fullText;
        // Fix unpaired tags after truncation
        if (useHtml) {
          // If truncation cut off an opening <pre>/<code>, close the orphan
          const openPre = (display.match(/<pre[\s>]/g) || []).length;
          const closePre = (display.match(/<\/pre>/g) || []).length;
          if (closePre > openPre) {
            display = "<pre><code>" + display;
          }
        } else {
          const fenceCount = (display.match(/^```/gm) || []).length;
          if (fenceCount % 2 !== 0) {
            display = "```\n" + display;
          }
        }
        parts.push(display);
      }
      return parts.join("\n\n");
    };

    const sendUpdate = async (): Promise<void> => {
      if (inflightUpdate) {
        await inflightUpdate;
      }
      const text = buildDisplay();
      if (!text) return;
      const activity: Record<string, unknown> = { type: "message", text };
      if (useHtml) activity.textFormat = "xml";
      try {
        if (!streamingActivityId) {
          // First update — send a new message and remember its id
          const resp = await sendFn(activity);
          streamingActivityId = resp?.id;
        } else {
          // Subsequent updates — update the same message in place
          await updateFn(streamingActivityId, activity);
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
          promptSuggestion = event.promptSuggestion;
          return;
        }

        if (event.type === "file_diff") {
          const cwd = state.getWorkDir();
          const shortPath = event.filePath?.startsWith(cwd + "/")
            ? event.filePath.slice(cwd.length + 1)
            : event.filePath;
          const label = shortPath ?? "file";
          let diffDisplay: string;
          if (event.patch) {
            const escaped = event.patch
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/\n/g, "<br>");
            const blockId = `codeBlock-${Date.now()}`;
            const lang = event.filePath
              ? codeBlockLanguage(event.filePath)
              : "plaintext";
            diffDisplay = `📝 ${label}<p itemtype="http://schema.skype.com/CodeBlockEditor" id="x_${blockId}">\u00a0</p><pre class="language-${lang}" itemid="${blockId}"><code>${escaped}</code></pre>`;
          } else {
            diffDisplay = `📝 Edited ${label}`;
          }
          useHtml = true;
          completedText += (streamingText ?? "") + "\n\n" + diffDisplay;
          streamingText = undefined;
          scheduleUpdate(TEXT_THROTTLE_MS);
          return;
        }

        if (event.type === "tool_result") {
          completedText += (streamingText ?? "") + "\n\n" + event.result;
          streamingText = undefined;
          scheduleUpdate(TEXT_THROTTLE_MS);
          return;
        }

        if (event.type === "auth_error") {
          completedText +=
            (streamingText ?? "") +
            "\n\n🔑 Login expired — run `claude login` in terminal";
          streamingText = undefined;
          scheduleUpdate(TOOL_THROTTLE_MS);
          return;
        }

        if (event.type === "todo") {
          const completed = event.todos.filter(
            (t) => t.status === "completed",
          ).length;
          const lines = event.todos.map((t) => {
            const icon =
              t.status === "completed"
                ? "✅"
                : t.status === "in_progress"
                  ? "🔧"
                  : "⏳";
            const text =
              t.status === "in_progress" && t.activeForm
                ? t.activeForm
                : t.content;
            return `${icon} ${text}`;
          });
          completedText += (streamingText ?? "") + "\n\n";
          streamingText = undefined;
          todoDisplay = `📋 ${completed}/${event.todos.length}\n\n${lines.join("\n\n")}`;
          scheduleUpdate(TOOL_THROTTLE_MS);
          return;
        }

        if (event.type === "rate_limit") {
          const msg =
            event.status === "rejected"
              ? `⚠️ Rate limited.${event.resetsAt ? ` Resets at ${new Date(event.resetsAt).toLocaleTimeString()}.` : ""}`
              : `⚠️ Approaching rate limit.${event.resetsAt ? ` Resets at ${new Date(event.resetsAt).toLocaleTimeString()}.` : ""}`;
          completedText += (streamingText ?? "") + "\n\n" + msg;
          streamingText = undefined;
          scheduleUpdate(TOOL_THROTTLE_MS);
          return;
        }

        if (event.type === "text") {
          // SDK accumulates turnStreamingText via +=, so within the same
          // streaming segment event.text always starts with the previous
          // streamingText.  When the assistant message resets
          // turnStreamingText to "", the next segment starts fresh and
          // will NOT be a prefix-continuation.  Commit the old text so
          // it isn't overwritten.
          if (streamingText && !event.text.startsWith(streamingText)) {
            completedText += streamingText + "\n\n";
            streamingText = undefined;
          }
          streamingText = event.text;
          scheduleUpdate(TEXT_THROTTLE_MS);
          return;
        }

        const message = this.formatProgressMessage(event);
        if (!message) return;
        completedText += (streamingText ?? "") + "\n\n" + message;
        streamingText = undefined;
        scheduleUpdate(TOOL_THROTTLE_MS);
      },
      finalize: async (chunks: string[]) => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (inflightUpdate) {
          await inflightUpdate;
          inflightUpdate = undefined;
        }

        // Build the progress prefix (todo + accumulated text)
        const prefix: string[] = [];
        if (todoDisplay) {
          prefix.push(todoDisplay);
        }
        if (completedText.trim()) {
          prefix.push(completedText.trim());
        }

        if (useHtml && prefix.length > 0 && chunks.length > 0) {
          // HTML progress (diffs) and markdown response must be separate messages
          // because they use different textFormat
          const htmlText = prefix.join("\n\n---\n\n");
          const htmlMsg: Record<string, unknown> = {
            type: "message",
            text: htmlText,
            textFormat: "xml",
          };
          if (streamingActivityId) {
            await updateFn(streamingActivityId, htmlMsg);
            streamingActivityId = undefined;
          } else {
            await sendFn(htmlMsg);
          }
          // Send response chunks as separate markdown messages
          for (const chunk of chunks) {
            await sendFn({ type: "message", text: chunk });
          }
        } else {
          // No format conflict — combine as before
          if (prefix.length > 0) {
            const pre = prefix.join("\n\n---\n\n");
            if (chunks.length > 0) {
              chunks[0] = pre + "\n\n---\n\n" + chunks[0];
            } else {
              chunks = [pre];
            }
          }

          if (chunks.length === 0) return;

          const mkMsg = (t: string): Record<string, unknown> => {
            const msg: Record<string, unknown> = { type: "message", text: t };
            if (useHtml) msg.textFormat = "xml";
            return msg;
          };

          if (streamingActivityId) {
            await updateFn(streamingActivityId, mkMsg(chunks[0]));
            streamingActivityId = undefined;
          } else {
            await sendFn(mkMsg(chunks[0]));
          }

          for (let i = 1; i < chunks.length; i++) {
            await sendFn(mkMsg(chunks[i]));
          }
        }
      },
      getPromptSuggestion: () => promptSuggestion,
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
