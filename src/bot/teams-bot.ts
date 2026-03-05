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
  type ImageInput,
  type ProgressEvent,
} from "../claude/agent.js";
import { ConversationSession, type SessionConfig } from "../claude/session.js";
import { formatResponse, splitMessage } from "../claude/formatter.js";
import {
  resolvePermission,
  resolvePermissionWithSuggestion,
  createPermissionHandler,
} from "../claude/permissions.js";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import {
  buildElicitationFormCard,
  buildElicitationUrlCard,
  buildHandoffCard,
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
import { config, getPublicUrl } from "../config.js";
import { saveConversationRef } from "../handoff/store.js";
import { renderDiffImage } from "./diff-renderer.js";

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
  return `Something went wrong: ${error.slice(0, 200)}`;
}

export class ClaudeCodeBot extends ActivityHandler {
  private permissionCards = new Map<
    string,
    {
      toolName: string;
      input: Record<string, unknown>;
      decisionReason?: string;
      suggestions?: PermissionUpdate[];
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
      if (value.action === "resume_session") {
        const sessionId = value.sessionId as string;
        if (sessionId) {
          const cwd = value.cwd as string | undefined;
          if (cwd) {
            const r = state.setWorkDir(cwd);
            if (!r.ok) {
              await ctx.sendActivity(
                `Cannot resume — \`${cwd}\` is outside the allowed work directory.`,
              );
              return;
            }
          }
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

      if (
        value.action === "permission_allow" ||
        value.action === "permission_deny" ||
        value.action === "permission_allow_session"
      ) {
        const toolUseID = value.toolUseID as string;
        const allow = value.action !== "permission_deny";
        let resolved: boolean;
        if (value.action === "permission_allow_session") {
          resolved = resolvePermissionWithSuggestion(
            toolUseID,
            value.suggestionIndex as number,
          );
        } else {
          resolved = resolvePermission(toolUseID, allow);
        }
        const label = allow ? "✅ Allowed" : "❌ Denied";

        const cardInfo = this.permissionCards.get(toolUseID);
        this.permissionCards.delete(toolUseID);

        if (cardInfo) {
          await ctx.sendActivity(
            resolved ? label : "Permission request expired or not found.",
          );
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
        state.setPermissionMode(mode);
        await state.getSession()?.session.setPermissionMode(mode);
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

    // Handle slash commands
    if (!images && (await handleCommand(text, ctx))) return;

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

    // Fire and forget — replies sent via continueConversation in onResult
    console.log("[BOT] Sending message to session...");
    managed.session.send(text || "What is in this image?", images);
  }

  /** Create a ManagedSession with all callbacks wired up. */
  private createManagedSession(overrides?: {
    resume?: string;
    forkSession?: boolean;
    cwd?: string;
  }): state.ManagedSession {
    let conversationRef: Partial<import("botbuilder").ConversationReference> | null =
      null;
    let adapter: BotFrameworkAdapter | null = null;

    // Proactive sendActivity — works after handleMessage returns
    const sendActivity = async (
      activity: Record<string, unknown>,
    ) => {
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

    const sendPermCard = async (req: {
      toolName: string;
      input: Record<string, unknown>;
      toolUseID: string;
      decisionReason?: string;
      suggestions?: PermissionUpdate[];
    }) => {
      const card = buildPermissionCard(
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
        this.permissionCards.set(req.toolUseID, {
          toolName: req.toolName,
          input: req.input,
          decisionReason: req.decisionReason,
          suggestions: req.suggestions,
        });
      }
    };

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
      canUseTool: createPermissionHandler(sendPermCard),
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
      onProgress: (event: ProgressEvent) => {
        if (!currentProgress) {
          currentProgress = this.createProgressNotifier(sendActivity);
        }
        currentProgress.onProgress(event);
      },
      onResult: async (result: ClaudeResult) => {
        if (!currentProgress) {
          currentProgress = this.createProgressNotifier(sendActivity);
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
          const parts: string[] = ["🛑 Interrupted."];
          if (result.result) {
            parts.push(result.result);
          }
          await progress.finalize(splitMessage(parts.join("\n\n")));
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
        ? `The user handed off from Terminal to Teams (project: ${workDir ?? "unknown"}). You have the full terminal conversation history. Welcome them briefly, summarize what was being worked on, and ask what they need help with. Reply in the same language as the conversation above.`
        : `The user started a new session from Teams (project: ${workDir ?? "unknown"}). Welcome them briefly and ask what they need help with.`;

      // Fire and forget — reply sent via onResult callback
      managed.session.send(prompt);
    }
  }

  createProgressNotifier(sendFn: (activity: Record<string, unknown>) => Promise<{ id?: string } | undefined>): {
    onProgress: (event: ProgressEvent) => void;
    finalize: (chunks: string[]) => Promise<void>;
    getPromptSuggestion: () => string | undefined;
  } {
    const MAX_LINES = 10;
    const TOOL_THROTTLE_MS = 2000;
    const TEXT_THROTTLE_MS = 1000;
    const MAX_STREAMING_LEN = 4000;
    let lastSentAt = 0;
    let timer: NodeJS.Timeout | undefined;
    let inflightUpdate: Promise<void> | undefined;
    const progressLines: string[] = [];
    let streamingText: string | undefined;
    let todoDisplay: string | undefined;
    let pendingUpdate = false;
    let promptSuggestion: string | undefined;
    let streamSequence = 1;

    const buildDisplay = (): string => {
      const parts: string[] = [];
      if (todoDisplay) {
        parts.push(todoDisplay);
      }
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
      if (inflightUpdate) {
        await inflightUpdate;
      }
      const text = buildDisplay();
      if (!text) return;
      try {
        await sendFn({
          type: "typing",
          text,
          channelData: {
            streamType: "streaming",
            streamSequence: streamSequence++,
          },
        });
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
          const publicUrl = getPublicUrl();
          const diffEvent = event;
          (async () => {
            try {
              if (publicUrl) {
                const filename = await renderDiffImage(diffEvent);
                await sendFn({
                  type: "message",
                  text: diffEvent.filePath ?? "Diff",
                  attachments: [{
                    contentType: "image/png",
                    name: diffEvent.filePath ?? "diff.png",
                    contentUrl: `${publicUrl}/api/diffs/${filename}`,
                  }],
                });
                return;
              }
            } catch (err) {
              console.log(`[DIFF] Image render failed, falling back to text: ${err instanceof Error ? err.message : err}`);
            }
            // Text fallback — no Playwright or render failed
            const label = diffEvent.filePath ? `\`${diffEvent.filePath}\`` : "file";
            const lines = diffEvent.newString.split("\n").length;
            await sendFn({
              type: "message",
              text: `📝 Edited ${label} (${lines} lines)`,
            }).catch(() => {});
          })().catch((err) => console.error(`[DIFF] Unhandled diff error: ${err}`));
          return;
        }

        if (event.type === "tool_error") {
          progressLines.push(
            `⚠️ Tool error: ${this.truncateProgress(event.error, 200)}`,
          );
          scheduleUpdate(TOOL_THROTTLE_MS);
          return;
        }

        if (event.type === "auth_error") {
          progressLines.push(
            `🔑 Login expired — run \`claude login\` in terminal`,
          );
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
          todoDisplay = `📋 ${completed}/${event.todos.length}\n\n${lines.join("\n\n")}`;
          scheduleUpdate(TOOL_THROTTLE_MS);
          return;
        }

        if (event.type === "rate_limit") {
          const msg =
            event.status === "rejected"
              ? `⚠️ Rate limited.${event.resetsAt ? ` Resets at ${new Date(event.resetsAt).toLocaleTimeString()}.` : ""}`
              : `⚠️ Approaching rate limit.${event.resetsAt ? ` Resets at ${new Date(event.resetsAt).toLocaleTimeString()}.` : ""}`;
          progressLines.push(msg);
          scheduleUpdate(TOOL_THROTTLE_MS);
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
        if (chunks.length === 0) return;

        await sendFn({ type: "message", text: chunks[0] });

        for (let i = 1; i < chunks.length; i++) {
          await sendFn({ type: "message", text: chunks[i] });
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
