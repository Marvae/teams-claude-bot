import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { TEAMS_BOT_DATA_DIR } from "../paths.js";

const REFS_FILE =
  process.env.BOT_REFS_FILE ??
  resolve(TEAMS_BOT_DATA_DIR, "conversation-refs.json");

// userId -> conversationId (string)
let refs: Record<string, string> = {};

export function loadConversationRefs(): void {
  try {
    const raw = JSON.parse(readFileSync(REFS_FILE, "utf-8"));
    const migrated: Record<string, string> = {};
    let needsMigration = false;
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string") {
        migrated[key] = value;
      } else if (
        value &&
        typeof value === "object" &&
        "conversation" in (value as Record<string, unknown>)
      ) {
        const conv = (value as Record<string, unknown>).conversation;
        const convId =
          conv && typeof conv === "object"
            ? (conv as Record<string, unknown>).id
            : undefined;
        if (typeof convId === "string") {
          migrated[key] = convId;
          needsMigration = true;
        }
      }
    }
    refs = migrated;
    if (needsMigration) {
      persist();
      console.log("[STORE] Migrated conversation refs to new format");
    }
  } catch {
    refs = {};
  }
}

function persist(): void {
  mkdirSync(dirname(REFS_FILE), { recursive: true });
  writeFileSync(REFS_FILE, JSON.stringify(refs, null, 2), { mode: 0o600 });
}

export function saveConversationId(
  userId: string,
  conversationId: string,
): void {
  if (!userId || !conversationId) return;
  refs[userId] = conversationId;
  persist();
}

export function getConversationId(userId?: string): string | null {
  if (userId) {
    return refs[userId] ?? null;
  }
  const keys = Object.keys(refs);
  if (keys.length === 0) return null;
  return refs[keys[keys.length - 1]];
}
