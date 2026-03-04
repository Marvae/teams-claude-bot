import { readFileSync, writeFileSync } from "fs";
import { realpathSync, existsSync } from "fs";
import { resolve } from "path";
import { config } from "../config.js";

interface SessionData {
  claudeSessionId?: string;
  /** The cwd where the active session was created (used for SDK resume). */
  sessionCwd?: string;
  workDir?: string;
  model?: string;
  thinkingTokens?: number | null;
  permissionMode?: string;
  handoffMode?: "pickup";
  history?: Array<{ sessionId: string; workDir: string; usedAt: string }>;
}

type SessionStore = Record<string, SessionData>;

const SESSIONS_FILE = resolve(process.cwd(), ".sessions.json");

let sessions: SessionStore = {};

export function loadSessions(): void {
  try {
    const raw = readFileSync(SESSIONS_FILE, "utf-8");
    sessions = JSON.parse(raw) as SessionStore;
  } catch {
    sessions = {};
  }
}

function persist(): void {
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

function ensureEntry(conversationId: string): SessionData {
  if (!sessions[conversationId]) {
    sessions[conversationId] = {};
  }
  return sessions[conversationId];
}

/** Push current session into history before switching away. */
function pushHistory(conversationId: string): void {
  const entry = sessions[conversationId];
  if (!entry?.claudeSessionId) return;

  if (!entry.history) entry.history = [];

  // Don't duplicate
  if (entry.history.some((h) => h.sessionId === entry.claudeSessionId)) return;

  entry.history.push({
    sessionId: entry.claudeSessionId,
    workDir: entry.workDir ?? config.claudeWorkDir,
    usedAt: new Date().toISOString(),
  });

  // Keep last 10
  if (entry.history.length > 10) {
    entry.history = entry.history.slice(-10);
  }
}

export function getSession(conversationId: string): string | undefined {
  return sessions[conversationId]?.claudeSessionId;
}

/** Get the cwd bound to the active session (for SDK resume). */
export function getSessionCwd(conversationId: string): string | undefined {
  return sessions[conversationId]?.sessionCwd;
}

export function setSession(
  conversationId: string,
  claudeSessionId: string,
  /** The cwd where this session lives — stored as-is, no path validation. */
  cwd?: string,
): void {
  pushHistory(conversationId);
  const entry = ensureEntry(conversationId);
  entry.claudeSessionId = claudeSessionId;
  if (cwd !== undefined) {
    entry.sessionCwd = cwd;
  }
  persist();
}

export function clearSession(conversationId: string): void {
  const entry = sessions[conversationId];
  if (entry) {
    pushHistory(conversationId);
    delete entry.claudeSessionId;
    delete entry.sessionCwd;
    persist();
  }
}

export interface PastSession {
  index: number;
  sessionId: string;
  workDir: string;
  usedAt: string;
}

export function listPastSessions(conversationId: string): PastSession[] {
  const history = sessions[conversationId]?.history ?? [];
  return history.map((h, i) => ({
    index: i,
    sessionId: h.sessionId,
    workDir: h.workDir,
    usedAt: h.usedAt,
  }));
}

export function switchToSession(
  conversationId: string,
  index: number,
): PastSession | null {
  const history = sessions[conversationId]?.history;
  if (!history || index < 0 || index >= history.length) return null;

  const target = history[index];

  // Save current to history, restore target
  pushHistory(conversationId);
  const entry = ensureEntry(conversationId);
  entry.claudeSessionId = target.sessionId;
  entry.workDir = target.workDir;

  // Remove from history since it's now active
  history.splice(index, 1);

  persist();
  return { index, ...target };
}

export function setHandoffMode(conversationId: string, mode: "pickup"): void {
  ensureEntry(conversationId).handoffMode = mode;
  persist();
}

export function getHandoffMode(conversationId: string): "pickup" | undefined {
  return sessions[conversationId]?.handoffMode;
}

export function clearHandoffMode(conversationId: string): void {
  const entry = sessions[conversationId];
  if (entry) {
    delete entry.handoffMode;
    persist();
  }
}

export function getWorkDir(conversationId: string): string {
  return sessions[conversationId]?.workDir ?? config.claudeWorkDir;
}

export function getModel(conversationId: string): string | undefined {
  return sessions[conversationId]?.model;
}

export function setModel(conversationId: string, model: string): void {
  ensureEntry(conversationId).model = model;
  persist();
}

export function getThinkingTokens(
  conversationId: string,
): number | null | undefined {
  return sessions[conversationId]?.thinkingTokens;
}

export function setThinkingTokens(
  conversationId: string,
  tokens: number | null,
): void {
  ensureEntry(conversationId).thinkingTokens = tokens;
  persist();
}

export function getPermissionMode(conversationId: string): string | undefined {
  return sessions[conversationId]?.permissionMode;
}

export function setPermissionMode(conversationId: string, mode: string): void {
  ensureEntry(conversationId).permissionMode = mode;
  persist();
}

export function setWorkDir(
  conversationId: string,
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

  ensureEntry(conversationId).workDir = resolved;
  persist();
  return { ok: true };
}
