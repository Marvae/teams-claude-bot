import { describe, it, expect, afterAll } from "vitest";
import { rmSync, existsSync, mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Use a temp dir to isolate test data
const TEMP_CWD = mkdtempSync(join(tmpdir(), "claude-bot-handoff-"));
const TEMP_SESSIONS = join(TEMP_CWD, "session.json");
const TEMP_REFS = join(TEMP_CWD, "conversation-refs.json");
process.env.BOT_SESSIONS_FILE = TEMP_SESSIONS;
process.env.BOT_REFS_FILE = TEMP_REFS;

describe("handoff mode (state module)", () => {
  it("sets and gets handoff mode", async () => {
    const { setHandoffMode, getHandoffMode } =
      await import("../src/session/state.js");
    setHandoffMode("pickup");
    expect(getHandoffMode()).toBe("pickup");
  });

  it("clears handoff mode", async () => {
    const { setHandoffMode, getHandoffMode, clearHandoffMode } =
      await import("../src/session/state.js");
    setHandoffMode("pickup");
    clearHandoffMode();
    expect(getHandoffMode()).toBeUndefined();
  });

  it("returns undefined when no mode set", async () => {
    const { getHandoffMode, clearHandoffMode } =
      await import("../src/session/state.js");
    clearHandoffMode();
    expect(getHandoffMode()).toBeUndefined();
  });
});

// --- Conversation reference store tests ---

describe("conversation ref store", () => {
  const REFS_FILE = TEMP_REFS;

  afterAll(() => {
    if (existsSync(REFS_FILE)) rmSync(REFS_FILE);
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
