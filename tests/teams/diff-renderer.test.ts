import { describe, it, expect } from "vitest";
import { formatTextDiff } from "../../src/bot/text-diff.js";

describe("formatTextDiff", () => {
  it("shows a single-line change with context", () => {
    const result = formatTextDiff(
      "const x = 1;\nconst y = 2;\nconst z = 3;",
      "const x = 1;\nconst y = 42;\nconst z = 3;",
    );
    expect(result).toBe(
      "  const x = 1;\n- const y = 2;\n+ const y = 42;\n  const z = 3;",
    );
  });

  it("shows additions", () => {
    const result = formatTextDiff("a\nb", "a\nb\nc");
    expect(result).toContain("+ c");
  });

  it("shows deletions", () => {
    const result = formatTextDiff("a\nb\nc", "a\nc");
    expect(result).toContain("- b");
  });

  it("returns undefined for identical strings", () => {
    expect(formatTextDiff("hello", "hello")).toBeUndefined();
  });

  it("returns undefined for both empty", () => {
    expect(formatTextDiff("", "")).toBeUndefined();
  });

  it("handles empty old string (all additions)", () => {
    const result = formatTextDiff("", "line1\nline2");
    expect(result).toContain("+ line1");
    expect(result).toContain("+ line2");
  });

  it("handles empty new string (all deletions)", () => {
    const result = formatTextDiff("line1\nline2", "");
    expect(result).toContain("- line1");
    expect(result).toContain("- line2");
  });

  it("returns undefined when input exceeds 500 lines", () => {
    const big = Array(300).fill("line").join("\n");
    expect(formatTextDiff(big, big + "\nextra")).toBeUndefined();
  });

  it("returns undefined when output exceeds maxLines", () => {
    // Every line is different → all shown, exceeds default 30
    const old = Array(20).fill("old").join("\n");
    const neu = Array(20).fill("new").join("\n");
    expect(formatTextDiff(old, neu)).toBeUndefined();
  });

  it("respects custom maxLines", () => {
    const result = formatTextDiff("a", "b", 5);
    expect(result).toBeDefined();
    expect(formatTextDiff("a", "b", 1)).toBeUndefined();
  });

  it("inserts ... separator between distant hunks", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`);
    const modified = [...lines];
    modified[1] = "changed1";
    modified[8] = "changed8";
    const result = formatTextDiff(lines.join("\n"), modified.join("\n"));
    expect(result).toContain("  ...");
  });

  it("handles multi-line replacement", () => {
    const result = formatTextDiff(
      "function foo() {\n  return 1;\n}",
      "function foo() {\n  const x = 2;\n  return x;\n}",
    );
    expect(result).toContain("- ");
    expect(result).toContain("+ ");
    expect(result).toContain("  function foo() {");
  });
});
