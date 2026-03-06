import { ConversationReference, TurnContext } from "botbuilder";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { TEAMS_BOT_DATA_DIR } from "../paths.js";

const REFS_FILE =
  process.env.BOT_REFS_FILE ??
  resolve(TEAMS_BOT_DATA_DIR, "conversation-refs.json");

// userId -> ConversationReference
let refs: Record<string, Partial<ConversationReference>> = {};

export function loadConversationRefs(): void {
  try {
    refs = JSON.parse(readFileSync(REFS_FILE, "utf-8"));
  } catch {
    refs = {};
  }
}

function persist(): void {
  mkdirSync(dirname(REFS_FILE), { recursive: true });
  writeFileSync(REFS_FILE, JSON.stringify(refs, null, 2), { mode: 0o600 });
}

export function saveConversationRef(ctx: TurnContext): void {
  const userId =
    ctx.activity.from.aadObjectId?.toLowerCase() ??
    ctx.activity.from.name?.toLowerCase();
  if (!userId) return;

  refs[userId] = TurnContext.getConversationReference(ctx.activity);
  persist();
}

export function getConversationRef(
  userId?: string,
): Partial<ConversationReference> | null {
  // If userId provided, look up by userId
  if (userId) {
    return refs[userId] ?? null;
  }
  // Otherwise return the most recently saved ref (single-user mode)
  const keys = Object.keys(refs);
  if (keys.length === 0) return null;
  return refs[keys[keys.length - 1]];
}
