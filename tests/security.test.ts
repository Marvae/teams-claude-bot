import { describe, it, expect, afterAll } from "vitest";
import { statSync, rmSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEMP_DIR = mkdtempSync(join(tmpdir(), "claude-bot-sec-"));
const TEMP_REFS = join(TEMP_DIR, "conversation-refs.json");
process.env.BOT_REFS_FILE = TEMP_REFS;

// Rate limiter tests moved to tests/handoff-api.test.ts (tests the real code, not a copy)

describe("handoff token", () => {
  it("is always a non-empty string", async () => {
    const { config } = await import("../src/config.js");
    expect(config.handoffToken).toBeTruthy();
    expect(config.handoffToken.length).toBeGreaterThan(0);
  });
});

describe("conversation refs file permissions", () => {
  afterAll(() => {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  });

  it("writes refs file with owner-only permissions (0600)", async () => {
    const { loadConversationRefs, saveConversationId } =
      await import("../src/handoff/store.js");
    loadConversationRefs();

    saveConversationId("test-sec-user", "conv-sec-1");

    if (process.platform !== "win32") {
      const stats = statSync(TEMP_REFS);
      // 0o600 = owner read+write only (no group/other)
      const perms = stats.mode & 0o777;
      expect(perms).toBe(0o600);
    }
  });
});
