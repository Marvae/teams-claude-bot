/**
 * Message handler — registers the `message` and `install.add` routes on the
 * Teams SDK App. Handles auth, attachments, commands, and dispatches to the
 * Claude session with stream resilience (90s timer with streaming→proactive fallback).
 */

import type { App } from "@microsoft/teams.apps";
import { TypingActivity } from "@microsoft/teams.api";
import type { IMessageActivity } from "@microsoft/teams.api";
import type { IActivityContext } from "@microsoft/teams.apps";
import { handleCommand } from "./commands.js";
import * as state from "../session/state.js";
import {
  processAttachments,
  filterPlatformAttachments,
  type ContentBlock,
} from "./attachments.js";
import { config } from "../config.js";
import { saveConversationId, getConversationId } from "../handoff/store.js";
import { interactiveCards } from "./cards.js";
import { createManagedSession } from "./bridge.js";

// ─── Stream cancellation detection ──────────────────────────────────
// Teams shows a Stop button during streaming. When clicked, the server
// returns 403 ContentStreamNotAllowed on subsequent sends. The SDK
// doesn't expose this yet (microsoft/teams.ts#101), so we patch the
// stream's internal send() to detect it and interrupt Claude.
//
// Depends on HttpStream internals (send, queue) from @microsoft/teams.apps@2.0.6.
// If the SDK upgrades and breaks this, check HttpStream's source for changes.

export function patchStreamCancellation(
  stream: IActivityContext["stream"] | undefined,
  onCancel: (isUserCancel: boolean) => void,
): void {
  if (!stream) return;
  const raw = stream as unknown as {
    send?: (activity: unknown) => Promise<unknown>;
    _canceled?: boolean;
    queue?: unknown[];
  };
  if (!raw.send) return;
  const origSend = raw.send.bind(raw);
  raw._canceled = false;

  raw.send = async (activity: unknown) => {
    if (raw._canceled) throw new Error("Stream canceled");
    try {
      return await origSend(activity);
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      if (status === 403) {
        raw._canceled = true;
        if (raw.queue) raw.queue = [];
        const errMsg =
          (err as { response?: { data?: { error?: { message?: string } } } })
            ?.response?.data?.error?.message ?? "";
        const isUserCancel = errMsg === "Content stream was cancelled by user.";
        console.log(
          `[BOT] Stream 403: ${errMsg || "unknown"} (userCancel=${isUserCancel})`,
        );
        onCancel(isUserCancel);
      }
      throw err;
    }
  };

  const origEmit = stream.emit.bind(stream);
  stream.emit = (activity: Parameters<typeof stream.emit>[0]) => {
    if (raw._canceled) return;
    origEmit(activity);
  };
}

// ─── Auth ─────────────────────────────────────────────────────────────────

function isUserAllowed(activity: IMessageActivity): boolean {
  if (config.allowedUsers.size === 0) return true;
  const aadId = activity.from.aadObjectId?.toLowerCase();
  const name = activity.from.name?.toLowerCase();
  if (aadId && config.allowedUsers.has(aadId)) return true;
  if (name && config.allowedUsers.has(name)) return true;
  return false;
}

// ─── Register routes ──────────────────────────────────────────────────────

export function registerMessageHandler(app: App): void {
  // interactiveCards is the shared module-level Map imported from ./cards.js

  app.on("message", async (ctx: IActivityContext<IMessageActivity>) => {
    const activity = ctx.activity;
    const hasText = (activity.text ?? "").trim().length > 0;
    const hasAttachments = activity.attachments && activity.attachments.length > 0;

    // Skip empty messages — no typing for these
    if (!hasText && !hasAttachments) return;

    // Typing indicator first — user sees "..." immediately
    await ctx.send(new TypingActivity());

    // Save conversationId for proactive messaging
    const convId = ctx.ref.conversation?.id;
    const userId =
      activity.from.aadObjectId?.toLowerCase() ??
      activity.from.name?.toLowerCase();
    if (userId && convId) {
      saveConversationId(userId, convId);
    }

    // Auth check
    if (!isUserAllowed(activity)) {
      await ctx.send("Sorry, you are not authorized to use this bot.");
      return;
    }

    let text = (activity.text ?? "").trim();

    // Commands are text-only — handle before any I/O
    if (text && (await handleCommand(text, ctx))) return;

    // Get or create session (sync — fast)
    const convIdForSession = convId ?? getConversationId(userId) ?? "";
    let managed = state.getSession();
    if (!managed) {
      managed = createManagedSession(app, convIdForSession, interactiveCards);
      state.setSession(managed);
    }

    // Run init prompt on new sessions
    if (!managed.session.hasQuery && config.sessionInitPrompt) {
      console.log("[BOT] Running session init prompt...");
      managed.session.send(config.sessionInitPrompt);
    }

    // Guard: if a turn is already in progress, queue the message
    if (managed.activeStream || managed.pendingStream || managed.onTurnComplete) {
      managed.session.send(text);
      return;
    }

    // Store stream ref — NOT activated yet (no emit/update).
    // Bridge will activate it on message_start. If no message_start
    // (e.g. /compact), stream stays untouched and closes silently.
    const { stream } = ctx;

    // Process attachments — downloads happen while user sees informative update
    const rawAttachments = hasAttachments
      ? filterPlatformAttachments(
          activity.attachments as Parameters<
            typeof filterPlatformAttachments
          >[0],
        )
      : undefined;
    let inlineBlocks: ContentBlock[] = [];
    if (rawAttachments && rawAttachments.length > 0) {
      const { contentBlocks, savedFiles, failed } = await processAttachments(
        { authToken: undefined },
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
        await ctx.send(`Failed to download: ${failed.join(", ")}`);
      }
    }

    if (!text && inlineBlocks.length === 0) return;

    patchStreamCancellation(stream, (isUserCancel) => {
      if (isUserCancel && !managed.streamExpired) {
        // User clicked Stop — interrupt Claude
        managed.session.interrupt();
      } else {
        // Stream expired (2min limit, size limit, etc.)
        if (!managed.streamExpired && managed.activeStream === stream) {
          managed.activeStream = undefined;
          managed.streamExpired = true;
          console.log("[BOT] Stream expired — switching to proactive messaging");
        }
      }
    });

    const resultPromise = new Promise<void>((resolve) => {
      managed.pendingStream = stream;
      managed.onTurnComplete = resolve;
    });

    console.log("[BOT] Sending message to session...");
    if (inlineBlocks.length > 0) {
      const content: ContentBlock[] = [
        ...inlineBlocks,
        ...(text ? [{ type: "text" as const, text }] : []),
      ];
      managed.session.send(content);
    } else {
      managed.session.send(text);
    }

    // Await until onResult resolves (or stream expires via 403)
    await resultPromise;
  });

  // Save conversation ref on bot install
  app.on("install.add", async (ctx: IActivityContext) => {
    const convId = ctx.ref.conversation?.id;
    const userId =
      ctx.activity.from?.aadObjectId?.toLowerCase() ??
      ctx.activity.from?.name?.toLowerCase();
    if (userId && convId) {
      saveConversationId(userId, convId);
    }
    console.log("[BOT] Installation update — conversation ref saved");
  });
}
