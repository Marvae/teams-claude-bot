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
import { config } from "../config.js";
import { TEAMS_BOT_DATA_DIR } from "../paths.js";

// ─── Types ───

export interface ManagedSession {
  session: ConversationSession;
  setRef: (ctx: unknown) => void;
}

// ─── Persistence ───

const SESSION_FILE = (
  process.env.BOT_SESSIONS_FILE ?? join(TEAMS_BOT_DATA_DIR, "session.json")
).replace(/^~/, homedir());

interface PersistedData {
  sessionId?: string;
  cwd?: string;
  permissionMode?: string;
  titles?: Record<string, string>;
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
  mkdirSync(dirname(SESSION_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(SESSION_FILE, JSON.stringify(data), { mode: 0o600 });
}

export function loadPersistedSessionId(): string | undefined {
  return loadPersisted().sessionId;
}

export function persistSessionId(id: string): void {
  const data = loadPersisted();
  data.sessionId = id;
  data.cwd = workDir;
  savePersisted(data);
}

export function clearPersistedSessionId(): void {
  const data = loadPersisted();
  delete data.sessionId;
  delete data.cwd;
  savePersisted(data);
}

/** Load persisted state into memory (call on startup). */
export function loadPersistedState(): void {
  const data = loadPersisted();
  // .env PERMISSION_MODE takes priority on restart; otherwise use persisted value
  if (process.env.PERMISSION_MODE) {
    permissionMode = config.defaultPermissionMode;
  } else if (data.permissionMode) {
    permissionMode = data.permissionMode;
  }
  // Restore cwd if valid; if invalid, leave sessionId so resume
  // fails naturally and the user sees the "could not resume" message.
  if (data.cwd && data.sessionId) {
    const r = setWorkDir(data.cwd);
    if (!r.ok) {
      console.warn(
        `[STATE] Persisted cwd no longer valid (${data.cwd}), resume will fail gracefully`,
      );
    }
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
    resetUsageStats();
  }
  // Reset permission mode to .env default for next session
  permissionMode = config.defaultPermissionMode;
}

// ─── In-memory preferences (reset on restart) ───

let workDir: string = config.claudeWorkDir;
let model: string | undefined = "claude-opus-4-6";
let thinkingTokens: number | null | undefined;
let permissionMode: string = config.defaultPermissionMode;
let handoffMode: "pickup" | undefined;

export function getWorkDir(): string {
  return workDir;
}

export function setWorkDir(
  dir: string,
): { ok: true } | { ok: false; error: string } {
  // Convert MSYS2/Git Bash Unix-style paths to Windows paths
  // e.g. /d/office/src -> D:/office/src (when pwd -W fails in the skill)
  if (process.platform === "win32" && /^\/[a-zA-Z]\//.test(dir)) {
    dir = dir[1].toUpperCase() + ":" + dir.slice(2);
  }

  let resolved: string;
  try {
    resolved = realpathSync(resolve(dir));
  } catch {
    return { ok: false, error: `Directory not found: \`${dir}\`` };
  }

  if (!existsSync(resolved)) {
    return { ok: false, error: `Directory not found: \`${dir}\`` };
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

// ─── Cumulative usage stats (reset on session destroy) ───

let totalCostUsd = 0;
let totalInputTokens = 0;
let totalOutputTokens = 0;
let totalTurns = 0;

export function addUsage(
  cost?: number,
  usage?: { inputTokens: number; outputTokens: number },
): void {
  totalTurns++;
  if (cost !== undefined) totalCostUsd += cost;
  if (usage) {
    totalInputTokens += usage.inputTokens;
    totalOutputTokens += usage.outputTokens;
  }
}

export function getUsageStats(): {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
} {
  return {
    costUsd: totalCostUsd,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    turns: totalTurns,
  };
}

function resetUsageStats(): void {
  totalCostUsd = 0;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  totalTurns = 0;
}

// ─── Bot-managed session titles ───

export function setSessionTitle(sessionId: string, title: string): void {
  const data = loadPersisted();
  data.titles = { ...data.titles, [sessionId]: title };
  savePersisted(data);
}

export function getBotTitle(sessionId: string): string | undefined {
  return loadPersisted().titles?.[sessionId];
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

