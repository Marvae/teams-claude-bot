import { readFileSync, writeFileSync } from "fs";
import { realpathSync, existsSync } from "fs";
import { resolve } from "path";
import { config } from "../config.js";

interface SessionData {
  claudeSessionId?: string;
  workDir?: string;
  model?: string;
  thinkingTokens?: number | null;
  permissionMode?: string;
}

type SessionStore = Record<string, SessionData>;

const SESSIONS_FILE = resolve(
  process.cwd(),
  ".sessions.json",
);

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

export function getSession(conversationId: string): string | undefined {
  return sessions[conversationId]?.claudeSessionId;
}

export function setSession(
  conversationId: string,
  claudeSessionId: string,
): void {
  ensureEntry(conversationId).claudeSessionId = claudeSessionId;
  persist();
}

export function clearSession(conversationId: string): void {
  const entry = sessions[conversationId];
  if (entry) {
    delete entry.claudeSessionId;
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

export function getPermissionMode(
  conversationId: string,
): string | undefined {
  return sessions[conversationId]?.permissionMode;
}

export function setPermissionMode(
  conversationId: string,
  mode: string,
): void {
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
