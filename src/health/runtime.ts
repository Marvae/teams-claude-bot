import { config } from "../config.js";
import * as state from "../session/state.js";

const RECENT_ERROR_WINDOW_MS = 10 * 60 * 1000;
const MAX_ERROR_LEN = 180;

let lastTurnError: { at: number; message: string } | null = null;
let resumeRecoveries = 0;
let lastResumeRecoveryAt: number | null = null;

function normalizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").slice(0, MAX_ERROR_LEN);
}

function shortSessionId(sessionId?: string): string | null {
  if (!sessionId) return null;
  if (sessionId.length <= 12) return sessionId;
  return `${sessionId.slice(0, 12)}…`;
}

export function markTurnError(error: unknown): void {
  lastTurnError = {
    at: Date.now(),
    message: normalizeError(error),
  };
}

export function markResumeRecovery(): void {
  resumeRecoveries++;
  lastResumeRecoveryAt = Date.now();
}

export interface RuntimeHealthSnapshot {
  status: "ok" | "degraded";
  timestamp: string;
  uptimeSec: number;
  pid: number;
  node: string;
  port: number;
  workDir?: string;
  session: {
    active: boolean;
    hasQuery: boolean;
    sessionId: string | null;
    idleSec: number | null;
    persistedSessionId: boolean;
    model: string | null;
    permissionMode: string;
  };
  recoveries: {
    resumeCount: number;
    lastResumeAt: string | null;
  };
  errors: {
    recentTurnError: boolean;
    lastTurnErrorAt: string | null;
    lastTurnError: string | null;
  };
}

export function getRuntimeHealthSnapshot(options?: {
  includeWorkDir?: boolean;
}): RuntimeHealthSnapshot {
  const now = Date.now();
  const session = state.getSession();
  const lastErrorAge = lastTurnError
    ? now - lastTurnError.at
    : Number.POSITIVE_INFINITY;
  const recentTurnError = lastErrorAge <= RECENT_ERROR_WINDOW_MS;

  const snapshot: RuntimeHealthSnapshot = {
    status: recentTurnError ? "degraded" : "ok",
    timestamp: new Date(now).toISOString(),
    uptimeSec: Math.floor(process.uptime()),
    pid: process.pid,
    node: process.version,
    port: config.port,
    session: {
      active: Boolean(session),
      hasQuery: session?.session.hasQuery ?? false,
      sessionId: shortSessionId(session?.session.currentSessionId),
      idleSec: session
        ? Math.max(0, Math.floor((now - session.session.lastActivityTime) / 1000))
        : null,
      persistedSessionId: Boolean(state.loadPersistedSessionId()),
      model: state.getModel() ?? null,
      permissionMode: state.getPermissionMode(),
    },
    recoveries: {
      resumeCount: resumeRecoveries,
      lastResumeAt: lastResumeRecoveryAt
        ? new Date(lastResumeRecoveryAt).toISOString()
        : null,
    },
    errors: {
      recentTurnError,
      lastTurnErrorAt: lastTurnError ? new Date(lastTurnError.at).toISOString() : null,
      lastTurnError: lastTurnError?.message ?? null,
    },
  };

  if (options?.includeWorkDir) {
    snapshot.workDir = state.getWorkDir();
  }

  return snapshot;
}
