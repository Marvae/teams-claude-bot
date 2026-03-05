import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  realpathSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

const SESSIONS_FILE = join(
  tmpdir(),
  `teams-bot-test-sessions-${process.pid}.json`,
);

// Point the state module at our temp file
process.env.BOT_SESSIONS_FILE = SESSIONS_FILE;

// Create a real temp dir for cwd tests — realpathSync resolves symlinks (e.g. /var → /private/var on macOS)
const RAW_DIR = join(tmpdir(), "resume-test-valid-dir");
if (!existsSync(RAW_DIR)) mkdirSync(RAW_DIR, { recursive: true });
const VALID_DIR = realpathSync(RAW_DIR);

function cleanup() {
  if (existsSync(SESSIONS_FILE)) {
    unlinkSync(SESSIONS_FILE);
  }
}

function readPersistedFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
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

  it("persists cwd alongside sessionId", async () => {
    const { persistSessionId, setWorkDir } =
      await import("../src/session/state.js");
    setWorkDir(VALID_DIR);
    persistSessionId("session-cwd");
    const data = readPersistedFile();
    expect(data.sessionId).toBe("session-cwd");
    expect(data.cwd).toBe(VALID_DIR);
  });

  it("clears persisted sessionId and cwd", async () => {
    const {
      persistSessionId,
      clearPersistedSessionId,
      loadPersistedSessionId,
      setWorkDir,
    } = await import("../src/session/state.js");
    setWorkDir(VALID_DIR);
    persistSessionId("session-abc");
    clearPersistedSessionId();
    expect(loadPersistedSessionId()).toBeUndefined();
    const data = readPersistedFile();
    expect(data.cwd).toBeUndefined();
  });

  it("loads sessionId from file on startup", async () => {
    writeFileSync(
      SESSIONS_FILE,
      JSON.stringify({ sessionId: "saved-session" }),
    );
    const { loadPersistedSessionId } = await import("../src/session/state.js");
    expect(loadPersistedSessionId()).toBe("saved-session");
  });

  it("loadPersistedState restores valid cwd", async () => {
    writeFileSync(
      SESSIONS_FILE,
      JSON.stringify({ sessionId: "s1", cwd: VALID_DIR }),
    );
    const { loadPersistedState, getWorkDir, loadPersistedSessionId } =
      await import("../src/session/state.js");
    loadPersistedState();
    expect(getWorkDir()).toBe(VALID_DIR);
    expect(loadPersistedSessionId()).toBe("s1");
  });

  it("loadPersistedState keeps sessionId when cwd is invalid (resume fails gracefully later)", async () => {
    writeFileSync(
      SESSIONS_FILE,
      JSON.stringify({ sessionId: "s2", cwd: "/nonexistent/path/xyz" }),
    );
    const { loadPersistedState, loadPersistedSessionId } =
      await import("../src/session/state.js");
    loadPersistedState();
    // sessionId is kept so resume attempt triggers user-visible error
    expect(loadPersistedSessionId()).toBe("s2");
  });
});
