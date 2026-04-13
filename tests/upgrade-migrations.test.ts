import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Temp dirs that will substitute for homeDir, projectDir, and cwd
let fakeHome: string;
let fakeProject: string;
let fakeCwd: string;

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-home-"));
  fakeProject = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-proj-"));
  fakeCwd = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-cwd-"));
  vi.spyOn(process, "cwd").mockReturnValue(fakeCwd);
});

afterEach(() => {
  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(fakeProject, { recursive: true, force: true });
  fs.rmSync(fakeCwd, { recursive: true, force: true });
  vi.restoreAllMocks();
});

vi.mock("../src/cli/constants.js", () => ({
  get projectDir() {
    return fakeProject;
  },
  get homeDir() {
    return fakeHome;
  },
}));

const { runUpgradeMigrations } = await import("../src/cli/skill.js");

function writeSettings(dir: string, data: Record<string, unknown>): string {
  const file = path.join(dir, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  return file;
}

function readSettings(dir: string): Record<string, unknown> {
  const file = path.join(dir, ".claude", "settings.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Write source skill template (ships with the package at skills/handoff/) */
function writeSrcSkill(dir: string, content: string, version = "1.0.0"): string {
  const file = path.join(dir, "skills", "handoff", "SKILL.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  // syncInstalledSkill reads package.json for version
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ version }),
  );
  return file;
}

/** Write installed skill (user's ~/.claude/skills/handoff/) */
function writeInstalledSkill(dir: string, content: string): string {
  const file = path.join(dir, ".claude", "skills", "handoff", "SKILL.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function readInstalledSkill(dir: string): string {
  return fs.readFileSync(
    path.join(dir, ".claude", "skills", "handoff", "SKILL.md"),
    "utf8",
  );
}

// ── cleanupLegacyHooks ──────────────────────────────────────────────

describe("cleanupLegacyHooks (via runUpgradeMigrations)", () => {
  it("removes SessionStart hook that references session-start.sh", () => {
    writeSettings(fakeHome, {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: "/some/path/.claude/hooks/session-start.sh",
              },
            ],
          },
        ],
      },
    });
    writeSrcSkill(fakeProject, "source");

    runUpgradeMigrations();

    const settings = readSettings(fakeHome);
    // hooks key is deleted entirely when empty
    expect(settings.hooks).toBeUndefined();
  });

  it("preserves non-legacy hooks", () => {
    writeSettings(fakeHome, {
      hooks: {
        SessionStart: [
          {
            hooks: [{ type: "command", command: "some-other-hook.sh" }],
          },
          {
            hooks: [
              { type: "command", command: "/path/session-start.sh" },
            ],
          },
        ],
      },
    });
    writeSrcSkill(fakeProject, "source");

    runUpgradeMigrations();

    const settings = readSettings(fakeHome);
    const groups = (settings.hooks as Record<string, unknown>)
      .SessionStart as unknown[];
    expect(groups).toHaveLength(1);
  });

  it("no-ops when no settings file exists", () => {
    writeSrcSkill(fakeProject, "source");
    expect(() => runUpgradeMigrations()).not.toThrow();
  });

  it("no-ops when no SessionStart hooks exist", () => {
    writeSettings(fakeHome, { permissions: {} });
    writeSrcSkill(fakeProject, "source");

    runUpgradeMigrations();

    const settings = readSettings(fakeHome);
    expect(settings).toEqual({ permissions: {} });
  });
});

// ── syncInstalledSkill ──────────────────────────────────────────────

describe("syncInstalledSkill (via runUpgradeMigrations)", () => {
  it("updates skill when version changes", () => {
    writeSrcSkill(fakeProject, "new content v2", "2.0.0");
    writeInstalledSkill(fakeHome, "old content v1");
    // Old version stamp
    fs.writeFileSync(
      path.join(fakeHome, ".claude", "skills", "handoff", ".version"),
      "1.0.0",
    );

    runUpgradeMigrations();

    expect(readInstalledSkill(fakeHome)).toBe("new content v2");
    expect(
      fs.readFileSync(
        path.join(fakeHome, ".claude", "skills", "handoff", ".version"),
        "utf8",
      ),
    ).toBe("2.0.0");
  });

  it("updates skill when no .version stamp exists (upgrade from old version)", () => {
    writeSrcSkill(fakeProject, "new content", "1.0.0");
    writeInstalledSkill(fakeHome, "old content");

    runUpgradeMigrations();

    expect(readInstalledSkill(fakeHome)).toBe("new content");
  });

  it("no-ops when version matches", () => {
    writeSrcSkill(fakeProject, "content", "1.0.0");
    const installed = writeInstalledSkill(fakeHome, "content");
    fs.writeFileSync(
      path.join(fakeHome, ".claude", "skills", "handoff", ".version"),
      "1.0.0",
    );
    const mtimeBefore = fs.statSync(installed).mtimeMs;

    runUpgradeMigrations();

    const mtimeAfter = fs.statSync(installed).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it("no-ops when skill is not installed", () => {
    writeSrcSkill(fakeProject, "source");

    expect(() => runUpgradeMigrations()).not.toThrow();
  });

  it("removes stale files from installed directory", () => {
    writeSrcSkill(fakeProject, "new content", "2.0.0");
    writeInstalledSkill(fakeHome, "old content");
    const staleFile = path.join(
      fakeHome, ".claude", "skills", "handoff", "get-session-id.sh",
    );
    fs.writeFileSync(staleFile, "#!/bin/bash\n");

    runUpgradeMigrations();

    expect(fs.existsSync(staleFile)).toBe(false);
    expect(readInstalledSkill(fakeHome)).toBe("new content");
  });

  it("no-ops when source SKILL.md is missing", () => {
    writeInstalledSkill(fakeHome, "installed content");

    expect(() => runUpgradeMigrations()).not.toThrow();
    expect(readInstalledSkill(fakeHome)).toBe("installed content");
  });
});
