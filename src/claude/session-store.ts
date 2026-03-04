import { ConversationSession } from "./session.js";
import type { ImageInput } from "./agent.js";

export type PendingMessage = { text: string; images?: ImageInput[] };

export interface ManagedSession {
  session: ConversationSession;
  /** Update the TurnContext reference for callbacks (canUseTool, elicitation, prompts). */
  setCtx: (ctx: unknown) => void;
  pendingMessages: PendingMessage[];
}

const sessions = new Map<string, ManagedSession>();

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get or create a managed session for a conversation.
 * The factory is only called if no session exists yet.
 */
export function getOrCreate(
  conversationId: string,
  factory: () => ManagedSession,
): ManagedSession {
  let entry = sessions.get(conversationId);
  if (!entry) {
    entry = factory();
    sessions.set(conversationId, entry);
  }
  return entry;
}

/** Get an existing session (for /stop, status checks). */
export function get(conversationId: string): ManagedSession | undefined {
  return sessions.get(conversationId);
}

/** Destroy a session (close query + remove from store). Used by /new, /clear. */
export function destroy(conversationId: string): void {
  const entry = sessions.get(conversationId);
  if (entry) {
    entry.session.close();
    sessions.delete(conversationId);
  }
}

/** Clean up idle sessions. */
function cleanupIdle(): void {
  if (sessions.size === 0) return;
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (now - entry.session.lastActivityTime > IDLE_TIMEOUT_MS) {
      console.log(
        `[SESSION-STORE] Closing idle session: ${id.slice(0, 20)}...`,
      );
      entry.session.close();
      sessions.delete(id);
    }
  }
}

// Periodic cleanup — unref so it doesn't keep the process alive
const cleanupTimer = setInterval(cleanupIdle, CHECK_INTERVAL_MS);
cleanupTimer.unref();
