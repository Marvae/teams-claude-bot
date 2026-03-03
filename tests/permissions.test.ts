import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createPermissionHandler,
  resolvePermission,
  clearPendingPermissions,
} from "../src/claude/permissions.js";

describe("permissions", () => {
  beforeEach(() => {
    clearPendingPermissions();
  });

  afterEach(() => {
    clearPendingPermissions();
  });

  describe("createPermissionHandler", () => {
    it("returns a canUseTool callback function", () => {
      const sendCard = vi.fn();
      const handler = createPermissionHandler(sendCard);
      expect(typeof handler).toBe("function");
    });

    it("calls sendCard with tool info when permission requested", async () => {
      let cardSent: () => void;
      const cardSentPromise = new Promise<void>((r) => (cardSent = r));
      const sendCard = vi.fn().mockImplementation(() => {
        cardSent();
        return Promise.resolve();
      });
      const handler = createPermissionHandler(sendCard);

      // Start the handler but don't await
      const resultPromise = handler(
        "Bash",
        { command: "rm -rf /" },
        { signal: new AbortController().signal, toolUseID: "tool-123" },
      );

      // Wait for sendCard to be called
      await cardSentPromise;

      // sendCard should be called with card data
      expect(sendCard).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "Bash",
          input: { command: "rm -rf /" },
          toolUseID: "tool-123",
        }),
      );

      // Resolve to avoid hanging
      resolvePermission("tool-123", true);
      await resultPromise;
    });
  });

  describe("resolvePermission", () => {
    it("resolves pending permission with allow", async () => {
      let cardSent: () => void;
      const cardSentPromise = new Promise<void>((r) => (cardSent = r));
      const sendCard = vi.fn().mockImplementation(() => {
        cardSent();
        return Promise.resolve();
      });
      const handler = createPermissionHandler(sendCard);

      const resultPromise = handler(
        "Bash",
        { command: "ls" },
        { signal: new AbortController().signal, toolUseID: "tool-456" },
      );

      await cardSentPromise;

      // Simulate user clicking Allow
      const resolved = resolvePermission("tool-456", true);
      expect(resolved).toBe(true);

      const result = await resultPromise;
      expect(result.behavior).toBe("allow");
    });

    it("resolves pending permission with deny", async () => {
      let cardSent: () => void;
      const cardSentPromise = new Promise<void>((r) => (cardSent = r));
      const sendCard = vi.fn().mockImplementation(() => {
        cardSent();
        return Promise.resolve();
      });
      const handler = createPermissionHandler(sendCard);

      const resultPromise = handler(
        "Bash",
        { command: "ls" },
        { signal: new AbortController().signal, toolUseID: "tool-789" },
      );

      await cardSentPromise;

      // Simulate user clicking Deny
      resolvePermission("tool-789", false);

      const result = await resultPromise;
      expect(result.behavior).toBe("deny");
      expect(result.message).toBe("User denied permission");
    });

    it("returns false for unknown toolUseID", () => {
      expect(resolvePermission("unknown-id", true)).toBe(false);
    });
  });

  describe("timeout behavior", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("denies permission after timeout", async () => {
      let cardSent: () => void;
      const cardSentPromise = new Promise<void>((r) => (cardSent = r));
      const sendCard = vi.fn().mockImplementation(() => {
        cardSent();
        return Promise.resolve();
      });
      const handler = createPermissionHandler(sendCard, { timeoutMs: 5000 });

      const resultPromise = handler(
        "Bash",
        { command: "ls" },
        { signal: new AbortController().signal, toolUseID: "tool-timeout" },
      );

      await cardSentPromise;

      vi.advanceTimersByTime(5000);

      const result = await resultPromise;
      expect(result.behavior).toBe("deny");
      expect(result.message).toContain("timed out");
    });
  });
});
