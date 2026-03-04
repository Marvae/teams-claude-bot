/**
 * Unified session state — replaces session/manager.ts + claude/session-store.ts.
 *
 * Single-user (1:1 private chat) design:
 * - One live ConversationSession at a time (module-level variable, no Map)
 * - Only sessionId persisted to disk (for cross-restart resume)
 * - All preferences (model, thinking, permission, workDir) are memory-only
 * - SDK listSessions() is the source of truth for session history
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
  existsSync,
} from "fs";
import { join, dirname, resolve } from "path";
import { homedir } from "os";
import { ConversationSession } from "../claude/session.js";
import type { ImageInput } from "../claude/agent.js";
import { config } from "../config.js";

// ─── Types ───

export type PendingMessage = { text: string; images?: ImageInput[] };

export interface ManagedSession {
  session: ConversationSession;
  setCtx: (ctx: unknown) => void;
  pendingMessages: PendingMessage[];
}

// ─── Persistence ───

const SESSION_FILE =
  process.env.BOT_SESSIONS_FILE ??
  join(homedir(), ".claude", "teams-bot", "session.json");

interface PersistedData {
  sessionId?: string;
  permissionMode?: string;
}

function loadPersisted(): PersistedData {
  try {
    const raw = readFileSync(SESSION_FILE, "utf-8");
    return JSON.parse(raw) as PersistedData;
  } catch {
    return {};
  }
}

function savePersisted(data: PersistedData): void {
  mkdirSync(dirname(SESSION_FILE), { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(data));
}

export function loadPersistedSessionId(): string | undefined {
  return loadPersisted().sessionId;
}

export function persistSessionId(id: string): void {
  const data = loadPersisted();
  data.sessionId = id;
  savePersisted(data);
}

export function clearPersistedSessionId(): void {
  const data = loadPersisted();
  delete data.sessionId;
  savePersisted(data);
}

/** Load persisted state into memory (call on startup). */
export function loadPersistedState(): void {
  const data = loadPersisted();
  if (data.permissionMode) {
    permissionMode = data.permissionMode;
  }
}

// ─── Live session (single instance) ───

let managed: ManagedSession | null = null;

export function getSession(): ManagedSession | null {
  return managed;
}

export function setSession(m: ManagedSession): void {
  managed = m;
}

export function destroySession(): void {
  if (managed) {
    managed.session.close();
    managed = null;
  }
}

// ─── In-memory preferences (reset on restart) ───

let workDir: string = config.claudeWorkDir;
let model: string | undefined;
let thinkingTokens: number | null | undefined;
let permissionMode: string = "bypassPermissions";
let handoffMode: "pickup" | undefined;

export function getWorkDir(): string {
  return workDir;
}

export function setWorkDir(
  dir: string,
): { ok: true } | { ok: false; error: string } {
  const allowedRoot = realpathSync(config.claudeWorkDir);
  let resolved: string;
  try {
    resolved = realpathSync(resolve(dir));
  } catch {
    return { ok: false, error: `Not found: \`${dir}\`` };
  }

  if (!resolved.startsWith(allowedRoot)) {
    return { ok: false, error: `Path must be under \`${allowedRoot}\`` };
  }

  if (!existsSync(resolved)) {
    return { ok: false, error: `Not found: \`${dir}\`` };
  }

  workDir = resolved;
  return { ok: true };
}

export function getModel(): string | undefined {
  return model;
}

export function setModel(m: string): void {
  model = m;
}

export function getThinkingTokens(): number | null | undefined {
  return thinkingTokens;
}

export function setThinkingTokens(t: number | null): void {
  thinkingTokens = t;
}

export function getPermissionMode(): string {
  return permissionMode;
}

export function setPermissionMode(m: string): void {
  permissionMode = m;
  const data = loadPersisted();
  data.permissionMode = m;
  savePersisted(data);
}

export function getHandoffMode(): "pickup" | undefined {
  return handoffMode;
}

export function setHandoffMode(m: "pickup"): void {
  handoffMode = m;
}

export function clearHandoffMode(): void {
  handoffMode = undefined;
}

// ─── Cached SDK commands ───

let cachedCommands: Array<{ name: string; description: string }> | undefined;

export function getCachedCommands():
  | Array<{ name: string; description: string }>
  | undefined {
  return cachedCommands;
}

export function setCachedCommands(
  cmds: Array<{ name: string; description: string }>,
): void {
  cachedCommands = cmds;
}

// ─── Idle cleanup (single session) ───

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function cleanupIdle(): void {
  if (!managed) return;
  const now = Date.now();
  if (now - managed.session.lastActivityTime > IDLE_TIMEOUT_MS) {
    console.log("[STATE] Closing idle session");
    managed.session.close();
    managed = null;
  }
}

const cleanupTimer = setInterval(cleanupIdle, CHECK_INTERVAL_MS);
cleanupTimer.unref();
