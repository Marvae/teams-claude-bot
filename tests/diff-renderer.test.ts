import { describe, it, expect } from "vitest";
import { renderDiffImage } from "../src/bot/diff-renderer.js";

describe("renderDiffImage", () => {
  it("renders a simple diff to base64 PNG", async () => {
    const diff = {
      filePath: "test.ts",
      originalFile: "const x = 1;",
      newString: "const x = 2;"
    };
    
    const result = await renderDiffImage(diff);
    
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(100);
  }, 30000);
});
