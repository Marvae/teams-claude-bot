import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { rmSync, existsSync, mkdtempSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

// Use a temp file to isolate sessions
const TEMP_CWD = mkdtempSync(join(tmpdir(), "claude-bot-handoff-"));
const TEMP_SESSIONS = join(TEMP_CWD, "sessions.json");
process.env.BOT_SESSIONS_FILE = TEMP_SESSIONS;

// --- Handoff mode tests ---

describe("handoff mode", () => {
  beforeEach(async () => {
    const mod = await import("../src/session/manager.js");
    mod.loadSessions();
  });

  it("sets and gets handoff mode", async () => {
    const { setHandoffMode, getHandoffMode } =
      await import("../src/session/manager.js");
    setHandoffMode("conv-hm", "pickup");
    expect(getHandoffMode("conv-hm")).toBe("pickup");
  });

  it("clears handoff mode", async () => {
    const { setHandoffMode, getHandoffMode, clearHandoffMode } =
      await import("../src/session/manager.js");
    setHandoffMode("conv-hm2", "pickup");
    clearHandoffMode("conv-hm2");
    expect(getHandoffMode("conv-hm2")).toBeUndefined();
  });

  it("returns undefined when no mode set", async () => {
    const { getHandoffMode } = await import("../src/session/manager.js");
    expect(getHandoffMode("conv-nomode")).toBeUndefined();
  });
});

// --- Session history tests ---

const SESSIONS_FILE = TEMP_SESSIONS;

describe("session history", () => {
  beforeEach(async () => {
    if (existsSync(SESSIONS_FILE)) rmSync(SESSIONS_FILE);
    // Reset module state by clearing cache
    const mod = await import("../src/session/manager.js");
    mod.loadSessions();
  });
  afterEach(() => {
    if (existsSync(SESSIONS_FILE)) rmSync(SESSIONS_FILE);
  });

  it("pushes old session to history when setting new one", async () => {
    const { loadSessions, setSession, getSession, listPastSessions } =
      await import("../src/session/manager.js");
    loadSessions();
    setSession("conv-1", "session-old");
    setSession("conv-1", "session-new");
    expect(getSession("conv-1")).toBe("session-new");
    const past = listPastSessions("conv-1");
    expect(past).toHaveLength(1);
    expect(past[0].sessionId).toBe("session-old");
  });

  it("does not duplicate same session in history", async () => {
    const { loadSessions, setSession, listPastSessions } =
      await import("../src/session/manager.js");
    loadSessions();
    setSession("conv-1", "session-a");
    setSession("conv-1", "session-b");
    setSession("conv-1", "session-a");
    const past = listPastSessions("conv-1");
    const ids = past.map((s) => s.sessionId);
    expect(ids.filter((id) => id === "session-b")).toHaveLength(1);
  });

  it("switchToSession swaps active and history", async () => {
    const {
      loadSessions,
      setSession,
      getSession,
      switchToSession,
      listPastSessions,
    } = await import("../src/session/manager.js");
    loadSessions();
    setSession("conv-switch", "session-a");
    setSession("conv-switch", "session-b");
    // history: [session-a], active: session-b
    const past = listPastSessions("conv-switch");
    const idx = past.findIndex((s) => s.sessionId === "session-a");
    const switched = switchToSession("conv-switch", idx);
    expect(switched).not.toBeNull();
    expect(switched!.sessionId).toBe("session-a");
    expect(getSession("conv-switch")).toBe("session-a");
    const pastAfter = listPastSessions("conv-switch");
    expect(pastAfter.some((s) => s.sessionId === "session-b")).toBe(true);
  });

  it("switchToSession returns null for invalid index", async () => {
    const { loadSessions, setSession, switchToSession } =
      await import("../src/session/manager.js");
    loadSessions();
    setSession("conv-1", "session-a");
    expect(switchToSession("conv-1", 99)).toBeNull();
    expect(switchToSession("conv-1", -1)).toBeNull();
  });

  it("clearSession pushes to history", async () => {
    const {
      loadSessions,
      setSession,
      clearSession,
      getSession,
      listPastSessions,
    } = await import("../src/session/manager.js");
    loadSessions();
    setSession("conv-clear", "session-a");
    clearSession("conv-clear");
    expect(getSession("conv-clear")).toBeUndefined();
    const past = listPastSessions("conv-clear");
    expect(past).toHaveLength(1);
    expect(past[0].sessionId).toBe("session-a");
  });

  it("keeps at most 10 history entries", async () => {
    const { loadSessions, setSession, listPastSessions } =
      await import("../src/session/manager.js");
    loadSessions();
    for (let i = 0; i < 15; i++) {
      setSession("conv-1", `session-${i}`);
    }
    const past = listPastSessions("conv-1");
    expect(past.length).toBeLessThanOrEqual(10);
  });
});

// --- Conversation reference store tests ---

describe("conversation ref store", () => {
  const REFS_FILE = resolve(process.cwd(), ".conversation-refs.json");

  afterEach(() => {
    if (existsSync(REFS_FILE)) rmSync(REFS_FILE);
  });

  afterAll(() => {
    rmSync(TEMP_CWD, { recursive: true, force: true });
  });

  it("returns null when no refs saved", async () => {
    const { loadConversationRefs, getConversationRef } =
      await import("../src/handoff/store.js");
    loadConversationRefs();
    expect(getConversationRef("nobody")).toBeNull();
  });

  it("returns last saved ref in single-user mode", async () => {
    writeFileSync(
      REFS_FILE,
      JSON.stringify({ "user-1": { conversation: { id: "conv-1" } } }),
    );
    const { loadConversationRefs, getConversationRef } =
      await import("../src/handoff/store.js");
    loadConversationRefs();
    const ref = getConversationRef();
    expect(ref).not.toBeNull();
  });
});
