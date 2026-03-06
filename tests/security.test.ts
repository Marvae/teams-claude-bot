import { describe, it, expect, vi, afterAll } from "vitest";
import { statSync, rmSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEMP_DIR = mkdtempSync(join(tmpdir(), "claude-bot-sec-"));
const TEMP_REFS = join(TEMP_DIR, "conversation-refs.json");
process.env.BOT_REFS_FILE = TEMP_REFS;

describe("rate limiter", () => {
  // Test the rate limiter logic directly (same algorithm as src/index.ts)
  function rateLimit(windowMs: number, maxRequests: number) {
    const hits = new Map<string, number[]>();
    return (ip: string): boolean => {
      const now = Date.now();
      const windowStart = now - windowMs;
      const timestamps = (hits.get(ip) ?? []).filter((t) => t > windowStart);
      if (timestamps.length >= maxRequests) {
        return false; // blocked
      }
      timestamps.push(now);
      hits.set(ip, timestamps);
      return true; // allowed
    };
  }

  it("allows requests under the limit", () => {
    const check = rateLimit(60_000, 3);
    expect(check("1.2.3.4")).toBe(true);
    expect(check("1.2.3.4")).toBe(true);
    expect(check("1.2.3.4")).toBe(true);
  });

  it("blocks requests over the limit", () => {
    const check = rateLimit(60_000, 2);
    expect(check("1.2.3.4")).toBe(true);
    expect(check("1.2.3.4")).toBe(true);
    expect(check("1.2.3.4")).toBe(false);
  });

  it("tracks IPs independently", () => {
    const check = rateLimit(60_000, 1);
    expect(check("1.1.1.1")).toBe(true);
    expect(check("2.2.2.2")).toBe(true);
    expect(check("1.1.1.1")).toBe(false);
    expect(check("2.2.2.2")).toBe(false);
  });

  it("allows requests after window expires", () => {
    vi.useFakeTimers();
    const check = rateLimit(1000, 1);

    expect(check("1.2.3.4")).toBe(true);
    expect(check("1.2.3.4")).toBe(false);

    vi.advanceTimersByTime(1001);
    expect(check("1.2.3.4")).toBe(true);

    vi.useRealTimers();
  });
});

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
    const { TurnContext } = await import("botbuilder");
    const { loadConversationRefs, saveConversationRef } =
      await import("../src/handoff/store.js");
    loadConversationRefs();

    const mockCtx = {
      activity: {
        from: { aadObjectId: "test-sec-user", name: "test" },
        recipient: { id: "bot" },
        conversation: { id: "conv" },
        channelId: "msteams",
        serviceUrl: "https://test.com",
      },
    };
    vi.spyOn(TurnContext, "getConversationReference").mockReturnValue({
      conversation: { id: "conv" },
    } as never);

    saveConversationRef(mockCtx as never);

    const stats = statSync(TEMP_REFS);
    // 0o600 = owner read+write only (no group/other)
    const perms = stats.mode & 0o777;
    expect(perms).toBe(0o600);
  });
});
