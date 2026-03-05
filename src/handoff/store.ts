import { ConversationReference, TurnContext } from "botbuilder";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { logError, logInfo } from "../logging/logger.js";

const REFS_FILE = resolve(process.cwd(), ".conversation-refs.json");

// userId -> ConversationReference
let refs: Record<string, Partial<ConversationReference>> = {};

export function loadConversationRefs(): void {
  try {
    refs = JSON.parse(readFileSync(REFS_FILE, "utf-8"));
    logInfo("HANDOFF", "refs_loaded", { count: Object.keys(refs).length });
  } catch (error) {
    refs = {};
    logError("HANDOFF", "refs_load_failed", error, { refsFile: REFS_FILE });
  }
}

function persist(): void {
  try {
    writeFileSync(REFS_FILE, JSON.stringify(refs, null, 2), { mode: 0o600 });
    logInfo("HANDOFF", "refs_persisted", {
      refsFile: REFS_FILE,
      count: Object.keys(refs).length,
    });
  } catch (error) {
    logError("HANDOFF", "refs_persist_failed", error, { refsFile: REFS_FILE });
  }
}

export function saveConversationRef(ctx: TurnContext): void {
  const userId =
    ctx.activity.from.aadObjectId?.toLowerCase() ??
    ctx.activity.from.name?.toLowerCase();
  if (!userId) return;

  refs[userId] = TurnContext.getConversationReference(ctx.activity);
  logInfo("HANDOFF", "ref_saved", {
    userId,
    conversationId: ctx.activity.conversation?.id,
  });
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
