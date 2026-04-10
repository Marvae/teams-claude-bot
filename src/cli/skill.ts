import fs from "fs";
import path from "path";
import { TEAMS_BOT_DATA_DIR } from "../paths.js";
import { projectDir, homeDir } from "./constants.js";
import {
  prompt,
  normalizeYesNo,
  readJson,
  writeJson,
} from "./utils.js";

export function getConversationRefsPath(): string {
  return path.join(TEAMS_BOT_DATA_DIR, "conversation-refs.json");
}

export async function maybeInstallSkillPrompt(): Promise<void> {
  // Check where it's currently installed
  const globalPath = path.join(
    homeDir,
    ".claude",
    "skills",
    "handoff",
    "SKILL.md",
  );
  const localPath = path.join(
    process.cwd(),
    ".claude",
    "skills",
    "handoff",
    "SKILL.md",
  );
  const isGlobal = fs.existsSync(globalPath);
  const isLocal = fs.existsSync(localPath);

  if (isGlobal || isLocal) {
    const scope = isGlobal ? "global (~/.claude/)" : "project (.claude/)";
    console.log(`  ✓ /handoff skill already installed (${scope})\n`);
    console.log("    1) Keep as-is");
    console.log("    2) Reinstall / change scope");
    console.log("    3) Uninstall\n");
    const choice = (await prompt("  Choose [1]: ")) || "1";
    if (choice === "3") {
      await uninstallSkill();
      return;
    }
    if (choice !== "2") return;
  } else {
    const answer = await prompt(
      "  Install /handoff skill for Claude Code? [Y/n]: ",
    );
    if (!normalizeYesNo(answer, true)) {
      console.log(
        "  Tip: Run 'teams-bot install-skill' later to enable /handoff.",
      );
      return;
    }
  }

  await installSkill();
}

function installSkillFiles(destinationDir: string, sourceDir: string): void {
  // Clean destination to remove stale files from older versions (e.g. get-session-id.sh)
  if (fs.existsSync(destinationDir)) {
    fs.rmSync(destinationDir, { recursive: true, force: true });
  }
  fs.mkdirSync(destinationDir, { recursive: true });

  const source = path.join(sourceDir, "SKILL.md");
  const destination = path.join(destinationDir, "SKILL.md");
  fs.copyFileSync(source, destination);
}

export async function installSkill(): Promise<void> {
  const skillSrcDir = path.join(projectDir, ".claude", "skills", "handoff");
  const skillSrc = path.join(skillSrcDir, "SKILL.md");

  if (!fs.existsSync(skillSrc)) {
    throw new Error(`Skill file not found at ${skillSrc}`);
  }

  // Bot runs locally — always use localhost
  const { loadExistingSetupConfig } = await import("./setup.js");
  const envConfig = loadExistingSetupConfig();
  const botUrl = `http://localhost:${envConfig.PORT || "3978"}`;

  console.log("\n  Where to install?");
  console.log("    1) Global (all projects)   ~/.claude/");
  console.log("    2) This project only       .claude/\n");

  const scopeChoice = (await prompt("  Choose [1]: ")) || "1";

  let settingsFile = path.join(projectDir, ".claude", "settings.json");
  let skillDestDir = path.join(projectDir, ".claude", "skills", "handoff");

  if (scopeChoice === "1") {
    settingsFile = path.join(homeDir, ".claude", "settings.json");
    skillDestDir = path.join(homeDir, ".claude", "skills", "handoff");
  }

  installSkillFiles(skillDestDir, skillSrcDir);
  console.log("✓ Skill installed");

  const settings = readJson(settingsFile);

  const env = ((settings.env as Record<string, unknown> | undefined) ??
    {}) as Record<string, unknown>;
  if (botUrl !== "http://localhost:3978") {
    env.TEAMS_BOT_URL = botUrl;
    settings.env = env;
    console.log("✓ Bot URL saved");
  } else if (env.TEAMS_BOT_URL) {
    delete env.TEAMS_BOT_URL;
  }

  if (settings.env && Object.keys(settings.env as object).length === 0) {
    delete settings.env;
  }

  writeJson(settingsFile, settings);

  console.log("\nDone! Restart Claude Code, then use /handoff.");
}

export async function uninstallSkill(): Promise<void> {
  const skillDirs = [
    path.join(homeDir, ".claude", "skills", "handoff"),
    path.join(process.cwd(), ".claude", "skills", "handoff"),
  ];

  for (const skillDir of skillDirs) {
    if (fs.existsSync(skillDir)) {
      fs.rmSync(skillDir, { recursive: true, force: true });
      console.log(`Removed skill from ${skillDir}`);
    }
  }

  // Clean up legacy SessionStart hooks that pointed to the now-removed session-start.sh
  const settingsFiles = [
    path.join(homeDir, ".claude", "settings.json"),
    path.join(process.cwd(), ".claude", "settings.json"),
  ];
  for (const settingsFile of settingsFiles) {
    if (!fs.existsSync(settingsFile)) continue;
    const settings = readJson(settingsFile);
    const hooks = settings.hooks as Record<string, unknown> | undefined;
    if (!hooks?.SessionStart) continue;
    const groups = hooks.SessionStart as Array<Record<string, unknown>>;
    const filtered = groups.filter((g) => {
      const gh = Array.isArray(g.hooks) ? g.hooks : [];
      return !gh.some(
        (h: Record<string, unknown>) =>
          typeof h.command === "string" &&
          h.command.includes("session-start.sh"),
      );
    });
    if (filtered.length < groups.length) {
      if (filtered.length === 0) delete hooks.SessionStart;
      else hooks.SessionStart = filtered;
      if (Object.keys(hooks).length === 0) delete settings.hooks;
      writeJson(settingsFile, settings);
      console.log(`Removed legacy hook from ${settingsFile}`);
    }
  }

  console.log("Uninstalled /handoff skill.");
}
