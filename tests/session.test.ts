import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const SESSIONS_FILE = join(
  tmpdir(),
  `teams-bot-test-sessions-${process.pid}.json`,
);

// Point the state module at our temp file
process.env.BOT_SESSIONS_FILE = SESSIONS_FILE;

function cleanup() {
  if (existsSync(SESSIONS_FILE)) {
    unlinkSync(SESSIONS_FILE);
  }
}

describe("session state persistence", () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  it("returns undefined when no persisted session", async () => {
    const { loadPersistedSessionId } = await import("../src/session/state.js");
    expect(loadPersistedSessionId()).toBeUndefined();
  });

  it("persists and retrieves sessionId", async () => {
    const { persistSessionId, loadPersistedSessionId } =
      await import("../src/session/state.js");
    persistSessionId("session-abc");
    expect(loadPersistedSessionId()).toBe("session-abc");
    expect(existsSync(SESSIONS_FILE)).toBe(true);
  });

  it("clears persisted sessionId", async () => {
    const {
      persistSessionId,
      clearPersistedSessionId,
      loadPersistedSessionId,
    } = await import("../src/session/state.js");
    persistSessionId("session-abc");
    clearPersistedSessionId();
    expect(loadPersistedSessionId()).toBeUndefined();
  });

  it("loads sessionId from file on startup", async () => {
    writeFileSync(
      SESSIONS_FILE,
      JSON.stringify({ sessionId: "saved-session" }),
    );
    const { loadPersistedSessionId } = await import("../src/session/state.js");
    expect(loadPersistedSessionId()).toBe("saved-session");
  });
});
