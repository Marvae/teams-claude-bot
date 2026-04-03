/**
 * Message handler — registers the `message` and `install.add` routes on the
 * Teams SDK App. Handles dedup, auth, attachments, commands,
 * and dispatches to the Claude session.
 *
 * No botbuilder imports — uses @microsoft/teams.apps and @microsoft/teams.api.
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
  onCancel: () => void,
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
    if (raw._canceled) throw new Error("Stream canceled by user");
    try {
      return await origSend(activity);
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      if (status === 403) {
        raw._canceled = true;
        if (raw.queue) raw.queue = [];
        console.log("[BOT] Stream canceled by user (403)");
        onCancel();
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

// ─── Dedup ────────────────────────────────────────────────────────────────

const processedActivities = new Map<string, number>();

function isDuplicate(activityId: string | undefined): boolean {
  if (!activityId) return false;
  if (processedActivities.has(activityId)) {
    console.log(`[BOT] Ignoring duplicate activity: ${activityId}`);
    return true;
  }
  processedActivities.set(activityId, Date.now());
  if (processedActivities.size > 100) {
    const cutoff = Date.now() - 60_000;
    for (const [id, ts] of processedActivities) {
      if (ts < cutoff) processedActivities.delete(id);
    }
  }
  return false;
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

    // Deduplicate
    if (isDuplicate(activity.id)) return;

    // Save conversationId for proactive messaging
    const convId = ctx.ref.conversation?.id;
    const userId =
      activity.from.aadObjectId?.toLowerCase() ??
      activity.from.name?.toLowerCase();
    if (userId && convId) {
      saveConversationId(userId, convId);
    }

    // Auth check (isValidTeamsRequest from old bot is intentionally dropped —
    // the new SDK validates JWT/service-URL at the framework level)
    if (!isUserAllowed(activity)) {
      await ctx.send("Sorry, you are not authorized to use this bot.");
      return;
    }

    let text = (activity.text ?? "").trim();

    // Process attachments — images/PDFs as inline content blocks, others saved to tmp
    const rawAttachments = activity.attachments
      ? filterPlatformAttachments(
          activity.attachments as Parameters<
            typeof filterPlatformAttachments
          >[0],
        )
      : undefined;
    let inlineBlocks: ContentBlock[] = [];
    if (rawAttachments && rawAttachments.length > 0) {
      // authToken: Teams file download URLs in personal scope include an
      // embedded token and don't need separate auth. If tenant-restricted
      // downloads fail, extract ctx.userToken here (requires OAuth setup).
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

    if (await handleCommand(text, ctx)) return;

    // Get or create the managed session.
    // Note: conversationId is captured once at session creation and reused for all
    // proactive messages. This is fine for a single-user personal-scope bot; in a
    // multi-user scenario we would need to re-resolve per message.
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

    // Show typing indicator
    await ctx.send(
      new TypingActivity({ channelData: { streamType: "informative" } }),
    );

    // Guard: if a turn is already in progress, queue the message instead of
    // overwriting activeStream/onTurnComplete (which would leak the previous promise).
    if (managed.activeStream) {
      managed.session.send(text);
      return;
    }

    // Set up native stream with cancellation detection
    const { stream } = ctx;
    patchStreamCancellation(stream, () => managed.session.interrupt());

    const resultPromise = new Promise<void>((resolve) => {
      managed.activeStream = stream;
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

    // Await until onResult resolves — stream auto-closes when handler returns
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
