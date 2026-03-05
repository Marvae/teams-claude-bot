import { describe, it, expect, afterAll } from "vitest";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { renderDiffImage, diffDir, cleanupOldDiffs } from "../src/bot/diff-renderer.js";

describe("renderDiffImage", () => {
  const createdFiles: string[] = [];

  afterAll(() => {
    for (const f of createdFiles) {
      try { unlinkSync(join(diffDir, f)); } catch {}
    }
  });

  it("renders a diff to PNG and returns filename", async () => {
    const diff = {
      filePath: "test.ts",
      originalFile: "const x = 1;",
      newString: "const x = 2;"
    };

    const filename = await renderDiffImage(diff);
    createdFiles.push(filename);

    expect(filename).toMatch(/^[a-f0-9-]+\.png$/);
    expect(existsSync(join(diffDir, filename))).toBe(true);
  }, 30000);
});

describe("cleanupOldDiffs", () => {
  it("does not throw on empty or missing dir", () => {
    expect(() => cleanupOldDiffs()).not.toThrow();
  });
});
