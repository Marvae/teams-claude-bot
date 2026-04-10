/**
 * Handoff REST endpoint — called by the /handoff skill in Claude Code
 * to send a handoff card to Teams via Bot Framework REST API.
 */

import express from "express";
import type { Request, Response } from "express";
import { MessageActivity } from "@microsoft/teams.api";
import { config } from "../config.js";
import { buildHandoffCard } from "../bot/cards.js";
import { getConversationId } from "./store.js";
import { getWorkDir } from "../session/state.js";

// ─── Rate limiter ────────────────────────────────────────────────────

const hits = new Map<string, number[]>();

function checkRate(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - 60_000;
  const timestamps = (hits.get(ip) ?? []).filter((t) => t > windowStart);
  if (timestamps.length >= 10) return false;
  timestamps.push(now);
  hits.set(ip, timestamps);
  if (hits.size > 1000) {
    for (const [key, ts] of hits) {
      if (ts.every((t) => t <= windowStart)) hits.delete(key);
    }
  }
  return true;
}

// ─── Bot Framework token ─────────────────────────────────────────────

async function getBotToken(): Promise<string> {
  const res = await fetch(
    `https://login.microsoftonline.com/${config.microsoftAppTenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.microsoftAppId,
        client_secret: config.microsoftAppPassword,
        scope: "https://api.botframework.com/.default",
        grant_type: "client_credentials",
      }),
    },
  );
  const data = (await res.json()) as {
    access_token?: string;
    error?: string;
  };
  if (!data.access_token) {
    throw new Error(`Token request failed: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

// ─── Send activity via REST API ──────────────────────────────────────

const SERVICE_URL = (
  process.env.SERVICE_URL ?? "https://smba.trafficmanager.net/teams"
).replace(/\/+$/, "");

async function sendActivity(
  conversationId: string,
  activity: Record<string, unknown>,
): Promise<void> {
  const token = await getBotToken();
  const res = await fetch(
    `${SERVICE_URL}/v3/conversations/${conversationId}/activities`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(activity),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bot Framework API ${res.status}: ${body}`);
  }
}

// ─── Route handler ───────────────────────────────────────────────────

async function handleHandoffRequest(
  req: Request,
  res: Response,
): Promise<void> {
  const ip = req.ip ?? "unknown";
  if (!checkRate(ip)) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }

  const token = req.headers["x-handoff-token"];
  if (token !== config.handoffToken) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  const {
    workDir: rawWorkDir,
    sessionId,
    summary,
    todos,
    buttonText,
    title,
  } = req.body ?? {};
  const workDir = (rawWorkDir as string) ?? getWorkDir();

  const conversationId = getConversationId();
  if (!conversationId) {
    res.status(404).json({
      success: false,
      error:
        "First time setup: send any message to the bot in Teams first, then retry /handoff. This is only needed once.",
    });
    return;
  }

  try {
    const card = buildHandoffCard(
      workDir,
      sessionId as string | undefined,
      summary as string | undefined,
      todos as { content: string; done: boolean }[] | undefined,
      buttonText as string | undefined,
      title as string | undefined,
    );

    const activity = new MessageActivity().addCard("adaptive", card);
    await sendActivity(conversationId, activity as Record<string, unknown>);

    console.log("[HANDOFF] Handoff card sent to Teams");
    res.json({ success: true });
  } catch (err) {
    console.error("[HANDOFF]", err instanceof Error ? err.stack : err);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("decrypt conversation")) {
      res.status(400).json({
        success: false,
        error:
          "Conversation expired. Send a message to the bot in Teams to refresh, then retry.",
      });
    } else if (msg.includes("403") || msg.includes("401")) {
      res.status(502).json({
        success: false,
        error:
          "Teams rejected the message. Check bot credentials (MICROSOFT_APP_PASSWORD may be expired).",
      });
    } else if (msg.includes("Token request failed")) {
      res.status(502).json({
        success: false,
        error: "Could not obtain bot token. Check Azure AD app credentials.",
      });
    } else {
      res.status(500).json({
        success: false,
        error: `Failed to send notification: ${msg.slice(0, 200)}`,
      });
    }
  }
}

// ─── Export: register route on adapter ───────────────────────────────

export function registerHandoffRoute(
  adapter: { post: (path: string, ...handlers: unknown[]) => void },
): void {
  adapter.post("/api/handoff", express.json(), handleHandoffRequest);
}

/** Send a proactive activity to the last known conversation (for use outside the route). */
export { sendActivity, getBotToken };
