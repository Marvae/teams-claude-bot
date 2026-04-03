import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createPromptCard,
  registerPromptRequest,
  resolvePromptRequest,
  clearPendingPrompts,
  type PromptRequestOption,
} from "../src/claude/user-input.js";

describe("user-input", () => {
  beforeEach(() => {
    clearPendingPrompts();
  });

  afterEach(() => {
    clearPendingPrompts();
  });

  describe("createPromptCard", () => {
    it("creates Adaptive Card with prompt message and options", () => {
      const options: PromptRequestOption[] = [
        { key: "yes", label: "Yes, proceed" },
        { key: "no", label: "No, cancel" },
      ];

      const card = createPromptCard(
        "req-1",
        "Do you want to continue?",
        options,
      );

      expect(card.type).toBe("AdaptiveCard");

      // Check body contains the message
      const body = card.body as Array<{ text?: string }>;
      expect(
        body.some((b) => b.text?.includes("Do you want to continue?")),
      ).toBe(true);

      // Check actions match options
      const actions = card.actions as Array<{
        title: string;
        data: { key: string };
      }>;
      expect(actions).toHaveLength(2);
      expect(actions[0].title).toBe("Yes, proceed");
      expect(actions[0].data.key).toBe("yes");
      expect(actions[1].title).toBe("No, cancel");
      expect(actions[1].data.key).toBe("no");
    });
  });

  describe("registerPromptRequest", () => {
    it("returns a promise that resolves with selected key", async () => {
      const promise = registerPromptRequest("req-2");

      // Simulate user selecting an option
      resolvePromptRequest("req-2", "option-a");

      const result = await promise;
      expect(result).toBe("option-a");
    });

    it("rejects duplicate requestId", async () => {
      registerPromptRequest("req-dup");

      await expect(registerPromptRequest("req-dup")).rejects.toThrow(
        "already exists",
      );

      // Cleanup
      resolvePromptRequest("req-dup", "x");
    });
  });

  describe("resolvePromptRequest", () => {
    it("returns true when request exists", async () => {
      registerPromptRequest("req-3");

      const resolved = resolvePromptRequest("req-3", "selected");
      expect(resolved).toBe(true);
    });

    it("returns false for unknown requestId", () => {
      expect(resolvePromptRequest("unknown", "x")).toBe(false);
    });
  });

  describe("timeout behavior", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects after timeout", async () => {
      const promise = registerPromptRequest("req-timeout", { timeoutMs: 5000 });

      vi.advanceTimersByTime(5000);

      await expect(promise).rejects.toThrow("timed out");
    });
  });
});
