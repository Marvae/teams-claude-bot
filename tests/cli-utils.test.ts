import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  normalizeYesNo,
  escapeSingleQuotes,
  ensureFile,
  readJson,
  writeJson,
  pathExistsAndNonEmpty,
} from "../src/cli/utils.js";
import { maskPassword } from "../src/cli/setup.js";
import { removeSessionStartHook } from "../src/cli/skill.js";

// Temp directory for file-based tests
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-utils-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("normalizeYesNo", () => {
  it("returns defaultYes when input is empty", () => {
    expect(normalizeYesNo("", true)).toBe(true);
    expect(normalizeYesNo("", false)).toBe(false);
  });

  it("returns true for Y/y inputs", () => {
    expect(normalizeYesNo("Y")).toBe(true);
    expect(normalizeYesNo("y")).toBe(true);
    expect(normalizeYesNo("yes")).toBe(true);
    expect(normalizeYesNo("Yes")).toBe(true);
  });

  it("returns false for non-Y inputs", () => {
    expect(normalizeYesNo("n")).toBe(false);
    expect(normalizeYesNo("N")).toBe(false);
    expect(normalizeYesNo("no")).toBe(false);
    expect(normalizeYesNo("anything")).toBe(false);
  });
});

describe("escapeSingleQuotes", () => {
  it("escapes single quotes for shell", () => {
    expect(escapeSingleQuotes("hello")).toBe("hello");
    expect(escapeSingleQuotes("it's")).toBe("it'\\''s");
    expect(escapeSingleQuotes("a'b'c")).toBe("a'\\''b'\\''c");
  });
});

describe("maskPassword", () => {
  it("masks short passwords entirely", () => {
    expect(maskPassword("ab")).toBe("****");
    expect(maskPassword("abcd")).toBe("****");
  });

  it("shows first 2 and last 2 chars for longer passwords", () => {
    expect(maskPassword("abcde")).toBe("ab*de");
    expect(maskPassword("secret123")).toBe("se*****23");
  });
});

describe("ensureFile", () => {
  it("creates file with fallback content if missing", () => {
    const filePath = path.join(tmpDir, "sub", "test.json");
    ensureFile(filePath);
    expect(fs.readFileSync(filePath, "utf8")).toBe("{}\n");
  });

  it("creates file with custom fallback", () => {
    const filePath = path.join(tmpDir, "custom.txt");
    ensureFile(filePath, "hello\n");
    expect(fs.readFileSync(filePath, "utf8")).toBe("hello\n");
  });

  it("does not overwrite existing file", () => {
    const filePath = path.join(tmpDir, "existing.json");
    fs.writeFileSync(filePath, '{"key":"value"}');
    ensureFile(filePath);
    expect(fs.readFileSync(filePath, "utf8")).toBe('{"key":"value"}');
  });
});

describe("readJson", () => {
  it("reads valid JSON file", () => {
    const filePath = path.join(tmpDir, "data.json");
    fs.writeFileSync(filePath, '{"foo":"bar"}');
    expect(readJson(filePath)).toEqual({ foo: "bar" });
  });

  it("returns empty object for empty file", () => {
    const filePath = path.join(tmpDir, "empty.json");
    fs.writeFileSync(filePath, "");
    expect(readJson(filePath)).toEqual({});
  });

  it("returns empty object for invalid JSON", () => {
    const filePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(filePath, "not json");
    expect(readJson(filePath)).toEqual({});
  });

  it("creates file if it does not exist", () => {
    const filePath = path.join(tmpDir, "new.json");
    const result = readJson(filePath);
    expect(result).toEqual({});
    expect(fs.existsSync(filePath)).toBe(true);
  });
});

describe("writeJson", () => {
  it("writes formatted JSON with trailing newline", () => {
    const filePath = path.join(tmpDir, "out.json");
    writeJson(filePath, { a: 1 });
    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toBe('{\n  "a": 1\n}\n');
  });

  it("creates intermediate directories", () => {
    const filePath = path.join(tmpDir, "deep", "nested", "file.json");
    writeJson(filePath, { x: true });
    expect(readJson(filePath)).toEqual({ x: true });
  });
});

describe("pathExistsAndNonEmpty", () => {
  it("returns false for missing file", () => {
    expect(pathExistsAndNonEmpty(path.join(tmpDir, "nope"))).toBe(false);
  });

  it("returns false for empty file", () => {
    const filePath = path.join(tmpDir, "empty");
    fs.writeFileSync(filePath, "");
    expect(pathExistsAndNonEmpty(filePath)).toBe(false);
  });

  it("returns false for file containing only {}", () => {
    const filePath = path.join(tmpDir, "empty-obj.json");
    fs.writeFileSync(filePath, "{}");
    expect(pathExistsAndNonEmpty(filePath)).toBe(false);
  });

  it("returns true for file with real content", () => {
    const filePath = path.join(tmpDir, "data.json");
    fs.writeFileSync(filePath, '{"id":"abc"}');
    expect(pathExistsAndNonEmpty(filePath)).toBe(true);
  });
});

describe("removeSessionStartHook", () => {
  it("returns false when no hooks exist", () => {
    const settings: Record<string, unknown> = {};
    expect(removeSessionStartHook(settings)).toBe(false);
  });

  it("returns false when no session-start.sh hook found", () => {
    const settings: Record<string, unknown> = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "echo hello" }] },
        ],
      },
    };
    expect(removeSessionStartHook(settings)).toBe(false);
  });

  it("removes session-start.sh hook and returns true", () => {
    const settings: Record<string, unknown> = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: "command", command: "/path/to/session-start.sh" },
            ],
          },
        ],
      },
    };
    expect(removeSessionStartHook(settings)).toBe(true);
    // SessionStart removed since no hooks left
    expect(settings.hooks).toBeUndefined();
  });

  it("keeps other hooks when removing session-start.sh", () => {
    const settings: Record<string, unknown> = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: "command", command: "/path/to/session-start.sh" },
            ],
          },
          {
            hooks: [{ type: "command", command: "echo other" }],
          },
        ],
      },
    };
    expect(removeSessionStartHook(settings)).toBe(true);
    const hooksObj = settings.hooks as Record<string, unknown>;
    const sessionStart = hooksObj.SessionStart as Array<Record<string, unknown>>;
    expect(sessionStart).toHaveLength(1);
    expect((sessionStart[0].hooks as Array<Record<string, unknown>>)[0].command).toBe("echo other");
  });
});
