import { describe, it, expect } from "vitest";
import { formatResponse, splitMessage } from "../src/claude/formatter.js";
import type { ClaudeResult } from "../src/claude/agent.js";

describe("formatResponse", () => {
  it("returns 'Done (no output)' when result is empty", () => {
    const result: ClaudeResult = { tools: [] };
    expect(formatResponse(result)).toBe("Done (no output)");
  });

  it("formats result text only", () => {
    const result: ClaudeResult = { result: "Hello world", tools: [] };
    expect(formatResponse(result)).toBe("Hello world");
  });

  it("formats tools with separator before result", () => {
    const result: ClaudeResult = {
      result: "Done",
      tools: [
        { name: "Read", file: "/src/index.ts" },
        { name: "Bash", command: "npm test" },
      ],
    };
    const output = formatResponse(result);
    expect(output).toContain("**Read**: `/src/index.ts`");
    expect(output).toContain("**Bash**: `npm test`");
    expect(output).toContain("---");
    expect(output).toContain("Done");
  });

  it("formats tool with pattern", () => {
    const result: ClaudeResult = {
      result: "Found files",
      tools: [{ name: "Glob", pattern: "**/*.ts" }],
    };
    expect(formatResponse(result)).toContain("**Glob**: `**/*.ts`");
  });

  it("formats tool with no details", () => {
    const result: ClaudeResult = {
      result: "Ok",
      tools: [{ name: "WebSearch" }],
    };
    expect(formatResponse(result)).toContain("- **WebSearch**");
  });
});

describe("splitMessage", () => {
  it("returns single chunk when under limit", () => {
    const chunks = splitMessage("short message", 100);
    expect(chunks).toEqual(["short message"]);
  });

  it("splits on newline boundary", () => {
    const text = "line1\nline2\nline3";
    const chunks = splitMessage(text, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n")).toBe(text);
  });

  it("splits at max length when no newline found", () => {
    const text = "a".repeat(30);
    const chunks = splitMessage(text, 10);
    expect(chunks.length).toBe(3);
    expect(chunks.join("")).toBe(text);
  });
});
