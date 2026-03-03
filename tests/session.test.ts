import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { resolve } from "path";

// We need to mock config before importing the session manager
// Use dynamic imports to control module loading order

const SESSIONS_FILE = resolve(process.cwd(), ".sessions.json");

function cleanup() {
  if (existsSync(SESSIONS_FILE)) {
    unlinkSync(SESSIONS_FILE);
  }
}

describe("session manager", () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  it("returns undefined for unknown conversation", async () => {
    const { loadSessions, getSession } =
      await import("../src/session/manager.js");
    loadSessions();
    expect(getSession("unknown-conv")).toBeUndefined();
  });

  it("persists and retrieves session", async () => {
    const { loadSessions, setSession, getSession } =
      await import("../src/session/manager.js");
    loadSessions();
    setSession("conv-1", "session-abc");
    expect(getSession("conv-1")).toBe("session-abc");
    expect(existsSync(SESSIONS_FILE)).toBe(true);
  });

  it("clears session", async () => {
    const { loadSessions, setSession, clearSession, getSession } =
      await import("../src/session/manager.js");
    loadSessions();
    setSession("conv-1", "session-abc");
    clearSession("conv-1");
    expect(getSession("conv-1")).toBeUndefined();
  });

  it("loads sessions from file on startup", async () => {
    writeFileSync(
      SESSIONS_FILE,
      JSON.stringify({ "conv-x": { claudeSessionId: "saved-session" } }),
    );
    const { loadSessions, getSession } =
      await import("../src/session/manager.js");
    loadSessions();
    expect(getSession("conv-x")).toBe("saved-session");
  });
});
