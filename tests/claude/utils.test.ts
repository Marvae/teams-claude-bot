import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { extname } from "path";
import { extractToolInfo, saveImagesToTmp } from "../../src/claude/types.js";
import type { ImageInput } from "../../src/claude/types.js";

const createdPaths: string[] = [];

afterEach(() => {
  for (const path of createdPaths.splice(0)) {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
});

describe("claude utils", () => {
  describe("extractToolInfo", () => {
    it("extracts supported fields from tool input", () => {
      const info = extractToolInfo("Read", {
        file_path: "src/index.ts",
        command: "npm test",
        pattern: "TODO",
      });

      expect(info).toEqual({
        name: "Read",
        file: "src/index.ts",
        command: "npm test",
        pattern: "TODO",
      });
    });

    it("truncates long commands to 100 characters", () => {
      const longCommand = "x".repeat(200);
      const info = extractToolInfo("Bash", { command: longCommand });

      expect(info.command).toBe("x".repeat(100));
    });

    it("returns only tool name when input is missing", () => {
      expect(extractToolInfo("Glob")).toEqual({ name: "Glob" });
    });
  });

  describe("saveImagesToTmp", () => {
    it("writes images to tmp files with expected extensions", async () => {
      const images: ImageInput[] = [
        {
          mediaType: "image/png",
          data: Buffer.from("png-data").toString("base64"),
        },
        {
          mediaType: "image/jpeg",
          data: Buffer.from("jpeg-data").toString("base64"),
        },
      ];

      const paths = await saveImagesToTmp(images);
      createdPaths.push(...paths);

      expect(paths).toHaveLength(2);
      expect(extname(paths[0])).toBe(".png");
      expect(extname(paths[1])).toBe(".jpg");
      expect(readFileSync(paths[0], "utf-8")).toBe("png-data");
      expect(readFileSync(paths[1], "utf-8")).toBe("jpeg-data");
    });

    it("falls back to .png for unknown media types", async () => {
      const paths = await saveImagesToTmp([
        {
          mediaType: "application/octet-stream",
          data: Buffer.from("raw").toString("base64"),
        },
      ]);
      createdPaths.push(...paths);

      expect(paths).toHaveLength(1);
      expect(extname(paths[0])).toBe(".png");
      expect(readFileSync(paths[0], "utf-8")).toBe("raw");
    });
  });
});
