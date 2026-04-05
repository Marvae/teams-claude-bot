import { describe, it, expect } from "vitest";
import { friendlyError } from "../src/bot/bridge.js";
import {
  formatProgressMessage,
  truncateProgress,
  codeBlockLanguage,
  progressToText,
} from "../src/claude/formatter.js";

describe("friendlyError", () => {
  it("returns refusal message for refusal stopReason", () => {
    expect(friendlyError("any error", "refusal")).toBe(
      "Claude declined this request.",
    );
  });

  it("returns friendly message for exit code 1", () => {
    expect(friendlyError("exited with code 1")).toContain("/new");
  });

  it("returns friendly message for session not found", () => {
    expect(friendlyError("Session not found")).toContain("/new");
  });

  it("returns friendly message for auth errors", () => {
    for (const keyword of [
      "auth",
      "unauthorized",
      "login",
      "credential",
      "OAuth",
    ]) {
      expect(friendlyError(`something ${keyword} failed`)).toContain(
        "claude login",
      );
    }
  });

  it("returns friendly message for rate limit", () => {
    expect(friendlyError("rate_limit exceeded")).toContain("rate limited");
    expect(friendlyError("429 too many requests")).toContain("rate limited");
  });

  it("returns friendly message for context length", () => {
    expect(friendlyError("context_length exceeded")).toContain("/new");
  });

  it("returns friendly message for timeout", () => {
    expect(friendlyError("timeout reached")).toContain("try again");
    expect(friendlyError("ETIMEDOUT")).toContain("try again");
  });

  it("returns friendly message for max_turns", () => {
    expect(friendlyError("max_turns exceeded")).toContain("smaller requests");
  });

  it("returns friendly message for image errors", () => {
    expect(friendlyError("request_too_large with image")).toContain(
      "too large",
    );
    expect(friendlyError("Could not process image")).toContain("too large");
  });

  it("returns generic message with truncation for unknown errors", () => {
    const long = "x".repeat(300);
    const result = friendlyError(long);
    expect(result).toContain("Something went wrong");
    expect(result.length).toBeLessThan(250);
  });
});

describe("formatProgressMessage", () => {
  it("formats tool_summary", () => {
    expect(
      formatProgressMessage({ type: "tool_summary", summary: "ran tests" }),
    ).toBe("📋 ran tests");
  });

  it("formats task_status", () => {
    expect(
      formatProgressMessage({
        type: "task_status",
        taskId: "1",
        status: "started",
        summary: "init",
      }),
    ).toContain("🚀");
    expect(
      formatProgressMessage({
        type: "task_status",
        taskId: "1",
        status: "completed",
        summary: "done",
      }),
    ).toContain("✅");
    expect(
      formatProgressMessage({
        type: "task_status",
        taskId: "1",
        status: "failed",
        summary: "err",
      }),
    ).toContain("⚠️");
  });

  it("formats Bash tool_use", () => {
    expect(
      formatProgressMessage({
        type: "tool_use",
        tool: { name: "Bash", command: "ls" },
      }),
    ).toBe("🔧 Running: ls");
  });

  it("formats Grep tool_use", () => {
    expect(
      formatProgressMessage({
        type: "tool_use",
        tool: { name: "Grep", pattern: "foo" },
      }),
    ).toBe("🔎 Searching: foo");
  });

  it("formats Read tool_use", () => {
    expect(
      formatProgressMessage({
        type: "tool_use",
        tool: { name: "Read", file: "src/a.ts" },
      }),
    ).toBe("📖 Reading: src/a.ts");
  });

  it("formats Edit/Write tool_use", () => {
    expect(
      formatProgressMessage({
        type: "tool_use",
        tool: { name: "Edit", file: "x.ts" },
      }),
    ).toBe("✍️ Editing: x.ts");
    expect(
      formatProgressMessage({
        type: "tool_use",
        tool: { name: "Write", file: "y.ts" },
      }),
    ).toBe("✍️ Writing: y.ts");
  });

  it("formats unknown tool_use", () => {
    expect(
      formatProgressMessage({ type: "tool_use", tool: { name: "Agent" } }),
    ).toBe("🔧 Running: Agent");
  });

  it("returns undefined for non-tool events", () => {
    expect(
      formatProgressMessage({ type: "text", text: "hi" } as never),
    ).toBeUndefined();
  });
});

describe("truncateProgress", () => {
  it("returns string unchanged if under limit", () => {
    expect(truncateProgress("short", 100)).toBe("short");
  });

  it("truncates with ellipsis", () => {
    const result = truncateProgress("a".repeat(50), 20);
    expect(result.length).toBe(20);
    expect(result).toMatch(/\.\.\.$/);
  });
});

describe("codeBlockLanguage", () => {
  it("maps common extensions", () => {
    expect(codeBlockLanguage("file.ts")).toBe("typescript");
    expect(codeBlockLanguage("file.py")).toBe("python");
    expect(codeBlockLanguage("file.sh")).toBe("bash");
  });

  it("returns extension for unmapped files", () => {
    expect(codeBlockLanguage("file.rs")).toBe("rs");
  });

  it("returns plaintext for no extension", () => {
    expect(codeBlockLanguage("Makefile")).toBe("plaintext");
  });
});

describe("progressToText", () => {
  it("returns text content for text events", () => {
    expect(progressToText({ type: "text", text: "hello" })).toBe("hello");
  });

  it("returns undefined for empty text", () => {
    expect(progressToText({ type: "text", text: "" })).toBeUndefined();
  });

  it("returns undefined for done events", () => {
    expect(progressToText({ type: "done" } as never)).toBeUndefined();
  });

  it("formats file_diff with language tag", () => {
    const result = progressToText({
      type: "file_diff",
      filePath: "/proj/src/index.ts",
      patch: "+code",
    } as never);
    expect(result).toContain("```typescript");
    expect(result).toContain("+code");
  });

  it("shortens file_diff paths relative to cwd", () => {
    const result = progressToText(
      { type: "file_diff", filePath: "/proj/src/index.ts", patch: "diff" } as never,
      "/proj",
    );
    expect(result).toContain("📝 src/index.ts");
  });

  it("formats auth_error", () => {
    const result = progressToText({ type: "auth_error", error: "expired" } as never);
    expect(result).toContain("🔑");
  });

  it("formats todo list", () => {
    const result = progressToText({
      type: "todo",
      todos: [
        { content: "Task 1", status: "completed" },
        { content: "Task 2", status: "in_progress" },
      ],
    } as never);
    expect(result).toContain("✅ Task 1");
    expect(result).toContain("🔧 Task 2");
    expect(result).toContain("1/2");
  });

  it("formats rate_limit rejected", () => {
    const result = progressToText({
      type: "rate_limit",
      status: "rejected",
    } as never);
    expect(result).toContain("Rate limited");
  });

  it("delegates tool_use to formatProgressMessage", () => {
    const result = progressToText({
      type: "tool_use",
      tool: { name: "Bash", command: "ls" },
    } as never);
    expect(result).toContain("🔧 Running: ls");
  });
});
