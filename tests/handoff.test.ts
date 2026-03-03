import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

// --- findSessionCwd tests ---

// Use a temp directory to avoid polluting real ~/.claude/projects
const TEST_BASE = join(tmpdir(), "claude-bot-test-" + process.pid);
const PROJECTS_DIR = join(TEST_BASE, ".claude", "projects");
const TEST_PROJECT = join(PROJECTS_DIR, "-test-handoff-project");
const TEST_SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function setupTestSession(lines: string[]) {
  mkdirSync(TEST_PROJECT, { recursive: true });
  writeFileSync(
    join(TEST_PROJECT, `${TEST_SESSION_ID}.jsonl`),
    lines.join("\n"),
  );
}

function cleanupTestSession() {
  if (existsSync(TEST_PROJECT)) {
    rmSync(TEST_PROJECT, { recursive: true });
  }
}

describe("findSessionCwd", () => {
  beforeEach(() => cleanupTestSession());
  afterEach(() => cleanupTestSession());
  afterAll(() => {
    if (existsSync(TEST_BASE)) rmSync(TEST_BASE, { recursive: true });
  });

  it("finds cwd when it is on the first line", async () => {
    setupTestSession([
      JSON.stringify({ cwd: "/test/project", sessionId: TEST_SESSION_ID }),
      JSON.stringify({ type: "message", text: "hello" }),
    ]);
    const { findSessionCwd } = await import("../src/claude/agent.js");
    expect(findSessionCwd(TEST_SESSION_ID, PROJECTS_DIR)).toBe("/test/project");
  });

  it("finds cwd when it is not on the first line", async () => {
    setupTestSession([
      JSON.stringify({ type: "queue-operation", operation: "dequeue", timestamp: "2026-01-01" }),
      JSON.stringify({ parentUuid: null, isSidechain: false }),
      JSON.stringify({ type: "system", cwd: "/test/deep/project" }),
    ]);
    const { findSessionCwd } = await import("../src/claude/agent.js");
    expect(findSessionCwd(TEST_SESSION_ID, PROJECTS_DIR)).toBe("/test/deep/project");
  });

  it("returns undefined for nonexistent session", async () => {
    const { findSessionCwd } = await import("../src/claude/agent.js");
    expect(findSessionCwd("nonexistent-0000-0000-0000-000000000000", PROJECTS_DIR)).toBeUndefined();
  });

  it("returns undefined when jsonl has no cwd field", async () => {
    setupTestSession([
      JSON.stringify({ type: "queue-operation" }),
      JSON.stringify({ type: "message", text: "no cwd here" }),
    ]);
    const { findSessionCwd } = await import("../src/claude/agent.js");
    expect(findSessionCwd(TEST_SESSION_ID, PROJECTS_DIR)).toBeUndefined();
  });

  it("handles malformed jsonl gracefully", async () => {
    setupTestSession([
      "not valid json",
      '{"cwd": "/recovery/path"}',
    ]);
    const { findSessionCwd } = await import("../src/claude/agent.js");
    expect(findSessionCwd(TEST_SESSION_ID, PROJECTS_DIR)).toBe("/recovery/path");
  });

  it("works with hyphenated directory names", async () => {
    const hyphenProject = join(PROJECTS_DIR, "-test-client-cocoa");
    mkdirSync(hyphenProject, { recursive: true });
    writeFileSync(
      join(hyphenProject, `${TEST_SESSION_ID}.jsonl`),
      JSON.stringify({ cwd: "/Users/test/Work/client-cocoa" }),
    );
    try {
      cleanupTestSession();
      const { findSessionCwd } = await import("../src/claude/agent.js");
      expect(findSessionCwd(TEST_SESSION_ID, PROJECTS_DIR)).toBe("/Users/test/Work/client-cocoa");
    } finally {
      rmSync(hyphenProject, { recursive: true });
    }
  });

  it("returns undefined when projects dir does not exist", async () => {
    const { findSessionCwd } = await import("../src/claude/agent.js");
    expect(findSessionCwd(TEST_SESSION_ID, "/nonexistent/path")).toBeUndefined();
  });
});

// --- getSessionSummary tests ---

describe("getSessionSummary", () => {
  beforeEach(() => cleanupTestSession());
  afterEach(() => cleanupTestSession());

  it("extracts user and assistant text messages", async () => {
    setupTestSession([
      JSON.stringify({ type: "user", message: { content: "help me fix the bug" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Sure, let me look at it." }] } }),
      JSON.stringify({ type: "user", message: { content: "thanks" } }),
    ]);
    const { getSessionSummary } = await import("../src/claude/agent.js");
    const summary = getSessionSummary(TEST_SESSION_ID, PROJECTS_DIR);
    expect(summary).toContain("help me fix the bug");
    expect(summary).toContain("Sure, let me look at it.");
    expect(summary).toContain("thanks");
  });

  it("skips tool_use blocks in assistant messages", async () => {
    setupTestSession([
      JSON.stringify({ type: "user", message: { content: "read the file" } }),
      JSON.stringify({ type: "assistant", message: { content: [
        { type: "tool_use", name: "Read", input: { file_path: "/tmp/test" } },
        { type: "text", text: "Here is the file content." },
      ] } }),
    ]);
    const { getSessionSummary } = await import("../src/claude/agent.js");
    const summary = getSessionSummary(TEST_SESSION_ID, PROJECTS_DIR);
    expect(summary).toContain("Here is the file content.");
    expect(summary).not.toContain("tool_use");
    expect(summary).not.toContain("file_path");
  });

  it("skips non-user/assistant message types", async () => {
    setupTestSession([
      JSON.stringify({ type: "system", cwd: "/test" }),
      JSON.stringify({ type: "queue-operation", operation: "dequeue" }),
      JSON.stringify({ type: "user", message: { content: "hello" } }),
    ]);
    const { getSessionSummary } = await import("../src/claude/agent.js");
    const summary = getSessionSummary(TEST_SESSION_ID, PROJECTS_DIR);
    expect(summary).toContain("hello");
    expect(summary).not.toContain("queue-operation");
  });

  it("returns undefined for nonexistent session", async () => {
    const { getSessionSummary } = await import("../src/claude/agent.js");
    expect(getSessionSummary("nonexistent-0000-0000-0000-000000000000", PROJECTS_DIR)).toBeUndefined();
  });

  it("returns undefined for empty transcript", async () => {
    setupTestSession([]);
    const { getSessionSummary } = await import("../src/claude/agent.js");
    expect(getSessionSummary(TEST_SESSION_ID, PROJECTS_DIR)).toBeUndefined();
  });

  it("truncates long summaries", async () => {
    const longText = "x".repeat(1000);
    const lines = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({ type: "user", message: { content: `msg ${i}: ${longText}` } }),
    );
    setupTestSession(lines);
    const { getSessionSummary } = await import("../src/claude/agent.js");
    const summary = getSessionSummary(TEST_SESSION_ID, PROJECTS_DIR);
    expect(summary).toBeDefined();
    expect(summary!.length).toBeLessThanOrEqual(4003); // 4000 + "..."
  });

  it("takes only last 10 messages", async () => {
    const lines = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({ type: "user", message: { content: `message-${i}` } }),
    );
    setupTestSession(lines);
    const { getSessionSummary } = await import("../src/claude/agent.js");
    const summary = getSessionSummary(TEST_SESSION_ID, PROJECTS_DIR);
    expect(summary).not.toContain("message-0");
    expect(summary).toContain("message-19");
  });
});

// --- Handoff mode tests ---

describe("handoff mode", () => {
  beforeEach(async () => {
    const mod = await import("../src/session/manager.js");
    mod.loadSessions();
  });

  it("sets and gets handoff mode", async () => {
    const { setHandoffMode, getHandoffMode } = await import("../src/session/manager.js");
    setHandoffMode("conv-hm", "pickup");
    expect(getHandoffMode("conv-hm")).toBe("pickup");
  });

  it("clears handoff mode", async () => {
    const { setHandoffMode, getHandoffMode, clearHandoffMode } = await import("../src/session/manager.js");
    setHandoffMode("conv-hm2", "resume");
    clearHandoffMode("conv-hm2");
    expect(getHandoffMode("conv-hm2")).toBeUndefined();
  });

  it("returns undefined when no mode set", async () => {
    const { getHandoffMode } = await import("../src/session/manager.js");
    expect(getHandoffMode("conv-nomode")).toBeUndefined();
  });
});

// --- Session history tests ---

const SESSIONS_FILE = join(tmpdir(), `claude-bot-test-sessions-${process.pid}.json`);

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
    const { loadSessions, setSession, getSession, switchToSession, listPastSessions } =
      await import("../src/session/manager.js");
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
    const { loadSessions, setSession, clearSession, getSession, listPastSessions } =
      await import("../src/session/manager.js");
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
