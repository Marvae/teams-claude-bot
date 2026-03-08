import { describe, it, expect, vi } from "vitest";

const stateValues = {
  managed: null as
    | null
    | {
        session: {
          hasQuery: boolean;
          currentSessionId?: string;
          lastActivityTime: number;
        };
      },
  workDir: "/work/test",
  model: "claude-opus-4-6" as string | undefined,
  permissionMode: "default",
  persistedSessionId: undefined as string | undefined,
};

vi.mock("../src/session/state.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getSession: vi.fn(() => stateValues.managed),
    getWorkDir: vi.fn(() => stateValues.workDir),
    getModel: vi.fn(() => stateValues.model),
    getPermissionMode: vi.fn(() => stateValues.permissionMode),
    loadPersistedSessionId: vi.fn(() => stateValues.persistedSessionId),
  };
});

import {
  getRuntimeHealthSnapshot,
  markResumeRecovery,
  markTurnError,
} from "../src/health/runtime.js";

describe("runtime health snapshot", () => {
  it("reports healthy snapshot by default", () => {
    const health = getRuntimeHealthSnapshot({ includeWorkDir: true });
    expect(health.status).toBe("ok");
    expect(health.workDir).toBe("/work/test");
    expect(health.session.active).toBe(false);
    expect(health.session.permissionMode).toBe("default");
  });

  it("reports degraded after turn error and tracks recovery count", () => {
    markTurnError(new Error("boom"));
    markResumeRecovery();
    stateValues.managed = {
      session: {
        hasQuery: true,
        currentSessionId: "session-1234567890",
        lastActivityTime: Date.now() - 1500,
      },
    };

    const health = getRuntimeHealthSnapshot();
    expect(health.status).toBe("degraded");
    expect(health.errors.recentTurnError).toBe(true);
    expect(health.recoveries.resumeCount).toBeGreaterThan(0);
    expect(health.session.active).toBe(true);
    expect(health.session.hasQuery).toBe(true);
    expect(health.session.sessionId).toContain("…");
  });
});
