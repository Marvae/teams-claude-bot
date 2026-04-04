/**
 * Session factory — creates managed Claude sessions with Teams proactive
 * messaging callbacks, and handles the handoff flow.
 */

import type { App } from "@microsoft/teams.apps";
import { MessageActivity } from "@microsoft/teams.api";
import type { ActivityParams, SentActivity } from "@microsoft/teams.api";
import type { IAdaptiveCard } from "@microsoft/teams.cards";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import {
  createPromptCard,
  registerPromptRequest,
} from "../claude/user-input.js";
import * as state from "../session/state.js";
import { type ClaudeResult, type ProgressEvent } from "../claude/agent.js";
import { ConversationSession, type SessionConfig } from "../claude/session.js";
import {
  formatResponse,
  splitMessage,
  codeBlockLanguage,
  formatProgressMessage,
} from "../claude/formatter.js";
import { createToolInterceptor } from "../claude/tool-interceptor.js";
import { buildToolCard } from "./cards.js";
import {
  handleElicitation,
  buildElicitationCard,
  buildElicitationUrlCard,
} from "../claude/elicitation.js";
import type { IStreamer } from "@microsoft/teams.apps";
import type { interactiveCards } from "./cards.js";
type InteractiveCards = typeof interactiveCards;

// ─── Native streaming progress (uses ctx.stream) ────────────────────────

export function createStreamingProgress(
  stream: IStreamer,
  sendFn: (activity: ActivityParams) => Promise<SentActivity | undefined>,
): {
  onProgress: (event: ProgressEvent) => void;
  finalize: (chunks: string[]) => Promise<void>;
  getPromptSuggestion: () => string | undefined;
} {
  let promptSuggestion: string | undefined;
  let hasEmitted = false;

  const emit = (content: string) => {
    hasEmitted = true;
    stream.emit(content);
  };

  let thinkingText = "";

  return {
    onProgress: (event: ProgressEvent) => {
      if (event.type === "done") {
        promptSuggestion = event.promptSuggestion;
        return;
      }

      if (event.type === "thinking") {
        thinkingText += event.text;
        if (!hasEmitted) {
          const display = thinkingText.length > 500
            ? "…" + thinkingText.slice(-499)
            : thinkingText;
          stream.update(`💭 Thinking: ${display}`);
        }
        return;
      }

      if (event.type === "file_diff") {

        const cwd = state.getWorkDir();
        const shortPath = event.filePath?.startsWith(cwd + "/")
          ? event.filePath.slice(cwd.length + 1)
          : event.filePath;
        const label = shortPath ?? "file";
        if (event.patch) {
          const lang = event.filePath
            ? codeBlockLanguage(event.filePath)
            : "plaintext";
          emit(`\n\n📝 ${label}\n\`\`\`${lang}\n${event.patch}\n\`\`\`\n\n`);
        } else {
          emit(`\n\n📝 Edited ${label}\n\n`);
        }
        return;
      }

      if (event.type === "tool_result") {

        emit(`\n\n${event.result}\n\n`);
        return;
      }

      if (event.type === "auth_error") {

        emit("\n\n🔑 Login expired — run `claude login` in terminal\n\n");
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
        emit(
          `\n\n📋 ${completed}/${event.todos.length}\n\n${lines.join("\n\n")}\n\n`,
        );
        return;
      }

      if (event.type === "rate_limit") {

        const msg =
          event.status === "rejected"
            ? `⚠️ Rate limited.${event.resetsAt ? ` Resets at ${new Date(event.resetsAt).toLocaleTimeString()}.` : ""}`
            : `⚠️ Approaching rate limit.${event.resetsAt ? ` Resets at ${new Date(event.resetsAt).toLocaleTimeString()}.` : ""}`;
        emit(`\n\n${msg}\n\n`);
        return;
      }

      if (event.type === "text") {
        if (event.text) {
          emit(event.text);
        }
        return;
      }

      // tool_use, tool_summary, task_status → emit as text in the stream
      // Note: stream.update() only works before first text chunk (SDK limitation),
      // so we use emit() for all progress to keep it visible throughout the turn.
      const message = formatProgressMessage(event);
      if (message) {
        emit("\n\n" + message + "\n\n");
      }
    },
    finalize: async (chunks: string[]) => {
      // Stream auto-closes when handler returns, merging emitted text into final message.
      // If nothing was emitted (e.g. error path), send all chunks proactively.
      const start = hasEmitted ? 1 : 0;
      for (let i = start; i < chunks.length; i++) {
        await sendFn(new MessageActivity(chunks[i]));
      }
    },
    getPromptSuggestion: () => promptSuggestion,
  };
}

// ─── Proactive progress (handoff context, no active stream) ─────────────

export function createProactiveProgress(
  sendFn: (activity: ActivityParams) => Promise<SentActivity | undefined>,
): {
  onProgress: (event: ProgressEvent) => void;
  finalize: (chunks: string[]) => Promise<void>;
  getPromptSuggestion: () => string | undefined;
} {
  let promptSuggestion: string | undefined;

  return {
    onProgress: (event: ProgressEvent) => {
      if (event.type === "done") {
        promptSuggestion = event.promptSuggestion;
      }
      // All other events are ignored — no streaming in handoff/proactive context
    },
    finalize: async (chunks: string[]) => {
      for (const chunk of chunks) {
        await sendFn(new MessageActivity(chunk));
      }
    },
    getPromptSuggestion: () => promptSuggestion,
  };
}

// ─── Friendly errors ──────────────────────────────────────────────────────

export function friendlyError(
  error: string,
  stopReason?: string | null,
): string {
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

// ─── Managed session factory ──────────────────────────────────────────────

export function createManagedSession(
  app: App,
  conversationId: string,
  interactiveCards: InteractiveCards,
  overrides?: {
    resume?: string;
    forkSession?: boolean;
    cwd?: string;
  },
): state.ManagedSession {
  // Proactive send — works after message handler returns
  const proactiveSend = async (
    activity: ActivityParams,
  ): Promise<SentActivity | undefined> => {
    if (!conversationId) return undefined;
    try {
      return await app.send(conversationId, activity);
    } catch {
      return undefined;
    }
  };

  // Proactive delete — delete a message by id
  const proactiveDelete = async (activityId: string): Promise<void> => {
    if (!conversationId) return;
    await app.api.conversations.activities(conversationId).delete(activityId);
  };

  const sendCard = async (card: IAdaptiveCard): Promise<string | undefined> => {
    const resp = await proactiveSend(
      new MessageActivity().addCard("adaptive", card),
    );
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
    const resp = await proactiveSend(
      new MessageActivity().addCard("adaptive", card),
    );
    if (resp?.id) {
      interactiveCards.set(req.toolUseID, {
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
            : buildElicitationCard(elicitationId, req);
        const activityId = await sendCard(card);
        if (activityId) {
          interactiveCards.set(elicitationId, {
            toolName: "Elicitation",
            input: {},
            activityId,
          });
        }
      },
      {
        timeoutMs: 120_000,
        onTimeout: async (elicitationId: string) => {
          const cardInfo = interactiveCards.get(elicitationId);
          interactiveCards.delete(elicitationId);
          if (cardInfo) {
            try {
              await proactiveDelete(cardInfo.activityId);
            } catch {
              /* card may be gone */
            }
          }
          await proactiveSend(new MessageActivity("⏰ Elicitation timed out."));
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
        const cardInfo = interactiveCards.get(requestId);
        interactiveCards.delete(requestId);
        if (cardInfo) {
          try {
            await proactiveDelete(cardInfo.activityId);
          } catch {
            /* card may be gone */
          }
        }
        await proactiveSend(
          new MessageActivity("⏰ Prompt request timed out."),
        );
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
      interactiveCards.set(info.requestId, {
        toolName: "PromptRequest",
        input: {},
        activityId,
      });
    }
    return response;
  };

  const cwd = overrides?.cwd ?? state.getWorkDir();
  const savedId = state.loadPersistedSessionId();

  // Auto-managed progress — created on first event, destroyed on result.
  // When managed.activeStream is set (native streaming), use createStreamingProgress;
  // otherwise fall back to the proactive send pattern (handoff context).
  let currentProgress: ReturnType<typeof createStreamingProgress> | null = null;
  let switchedToProactive = false;

  const getOrCreateProgress = () => {
    if (!currentProgress) {
      const managed = state.getSession();
      if (managed?.activeStream) {
        currentProgress = createStreamingProgress(
          managed.activeStream,
          proactiveSend,
        );
      } else {
        currentProgress = createProactiveProgress(proactiveSend);
      }
    }
    // If stream expired mid-turn, discard the dead streaming progress
    // and switch to proactive so onResult's finalize sends all chunks.
    const managed = state.getSession();
    if (managed?.streamExpired && !switchedToProactive) {
      switchedToProactive = true;
      currentProgress = createProactiveProgress(proactiveSend);
    }
    return currentProgress;
  };

  const sessionConfig: SessionConfig = {
    cwd,
    model: state.getModel(),
    thinkingTokens: state.getThinkingTokens(),
    permissionMode: state.getPermissionMode(),
    resume: overrides?.resume ?? savedId,
    forkSession: overrides?.forkSession,
    canUseTool: createToolInterceptor(sendToolCard, {
      onTimeout: async (toolUseID) => {
        const cardInfo = interactiveCards.get(toolUseID);
        interactiveCards.delete(toolUseID);
        if (cardInfo) {
          try {
            await proactiveDelete(cardInfo.activityId);
          } catch {
            /* card may be gone */
          }
        }
      },
    }),
    onElicitation,
    onPromptRequest,
    onSessionId: (id) => {
      state.persistSessionId(id);
      setTimeout(async () => {
        const managed = state.getSession();
        if (!managed) return;
        try {
          const cmds = await managed.session.getSupportedCommands();
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
      await proactiveSend(
        new MessageActivity(
          "Previous session could not be resumed. Retrying with a fresh session in the same project...",
        ),
      );
    },
    onProgress: (event: ProgressEvent) => {
      getOrCreateProgress().onProgress(event);
    },
    onResult: async (result: ClaudeResult) => {
      const progress = getOrCreateProgress();
      currentProgress = null;
      switchedToProactive = false;

      try {
        state.addUsage(result.costUsd, result.usage);

        if (result.error) {
          console.error(`[BOT] Error from session: ${result.error}`);
          await progress.finalize([
            friendlyError(result.error, result.stopReason),
          ]);
        } else if (result.interrupted) {
          console.log("[BOT] Turn was interrupted");
          if (result.result) {
            await progress.finalize(splitMessage(result.result));
          }
        } else {
          console.log("[BOT] Formatting and sending response");
          await progress.finalize(splitMessage(formatResponse(result)));
        }

        const suggestion = progress.getPromptSuggestion();
        if (suggestion) {
          try {
            await proactiveSend(
              new MessageActivity("").withSuggestedActions({
                to: [],
                actions: [
                  { type: "imBack", title: suggestion, value: suggestion },
                ],
              }),
            );
          } catch {
            // suggestedActions not supported — skip
          }
        }

        console.log("[BOT] Response sent successfully");
      } finally {
        // Always signal turn completion so the message handler can return
        const managed = state.getSession();
        if (managed?.activeStream) {
          managed.activeStream = undefined;
        }
        if (managed?.streamExpired) {
          managed.streamExpired = false;
        }
        if (managed?.onTurnComplete) {
          const resolve = managed.onTurnComplete;
          managed.onTurnComplete = undefined;
          resolve();
        }
      }
    },
  };

  const session = new ConversationSession(sessionConfig);

  return {
    session,
  };
}

// ─── Handoff handler ──────────────────────────────────────────────────────

export async function handleHandoff(
  app: App,
  conversationId: string,
  interactiveCards: InteractiveCards,
  action: string,
  workDir: string,
  sessionId?: string,
): Promise<void> {
  if (action === "handoff_accept") {
    if (workDir) {
      const r = state.setWorkDir(workDir);
      if (!r.ok) {
        await app.send(
          conversationId,
          new MessageActivity(`⚠️ Handoff rejected — ${r.error}`),
        );
        return;
      }
    }

    state.setHandoffMode("pickup");
    state.destroySession();
    state.clearPersistedSessionId();

    await app.send(
      conversationId,
      new MessageActivity(
        `🔄 Session handed off to Teams\n📂 \`${workDir}\`\n\nWhen you're done, use \`/handoff back\` to return control to Terminal.`,
      ),
    );

    console.log(`[HANDOFF] Fork: sessionId=${sessionId}, workDir=${workDir}`);

    const managed = createManagedSession(
      app,
      conversationId,
      interactiveCards,
      {
        resume: sessionId,
        forkSession: !!sessionId,
        cwd: state.getWorkDir(),
      },
    );
    state.setSession(managed);

    const prompt = sessionId
      ? `The user handed off from Terminal to Teams (project: ${workDir ?? "unknown"}). You have the full terminal conversation history. Greet them and let them know you're ready to continue. Reply in the same language as the conversation above.`
      : `The user started a new session from Teams (project: ${workDir ?? "unknown"}). Welcome them briefly and ask what they need help with.`;

    managed.session.send(prompt);
  }
}
