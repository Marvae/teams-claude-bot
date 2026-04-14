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
    console.log("    2) Reinstall");
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

/** Remove legacy SessionStart hooks that pointed to the now-removed session-start.sh */
function cleanupLegacyHooks(): void {
  const settingsFiles = [
    path.join(homeDir, ".claude", "settings.json"),
    path.join(process.cwd(), ".claude", "settings.json"),
  ];
  for (const settingsFile of settingsFiles) {
    if (!fs.existsSync(settingsFile)) continue;
    const settings = readJson(settingsFile);
    const hooks = settings.hooks as Record<string, unknown> | undefined;
    if (!hooks?.SessionStart) continue;
    if (!Array.isArray(hooks.SessionStart)) continue;
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
}

function getPackageVersion(): string {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(projectDir, "package.json"), "utf8"),
  );
  return pkg.version;
}

/** Replace destDir contents with srcDir contents. */
function copyDirSync(srcDir: string, destDir: string): void {
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
      continue;
    }
    if (!entry.isFile()) continue;
    fs.copyFileSync(srcPath, destPath);
  }
}

/** If the skill is installed and its version differs, sync it. */
function syncInstalledSkill(): void {
  const srcDir = path.join(projectDir, "skills", "handoff");
  if (!fs.existsSync(srcDir)) return;

  const currentVersion = getPackageVersion();
  const candidateDirs = [
    path.join(homeDir, ".claude", "skills", "handoff"),
    path.join(process.cwd(), ".claude", "skills", "handoff"),
  ];

  for (const installedDir of candidateDirs) {
    if (!fs.existsSync(path.join(installedDir, "SKILL.md"))) continue;
    const versionFile = path.join(installedDir, ".version");
    const installedVersion = fs.existsSync(versionFile)
      ? fs.readFileSync(versionFile, "utf8").trim()
      : "";
    if (installedVersion === currentVersion) continue;
    console.log(`Updating /handoff skill in ${installedDir} (${installedVersion || "unknown"} → ${currentVersion})...`);
    copyDirSync(srcDir, installedDir);
    fs.writeFileSync(versionFile, currentVersion);
    console.log(`✓ /handoff skill updated`);
  }
}

/**
 * Run all upgrade migrations. Call on bot start/restart so that
 * `npm update` + `teams-bot restart` is enough to complete an upgrade.
 */
export function runUpgradeMigrations(): void {
  cleanupLegacyHooks();
  syncInstalledSkill();
}

export async function installSkill(): Promise<void> {
  const skillSrcDir = path.join(projectDir, "skills", "handoff");
  const skillSrc = path.join(skillSrcDir, "SKILL.md");

  if (!fs.existsSync(skillSrc)) {
    throw new Error(`Skill file not found at ${skillSrc}`);
  }

  // Bot runs locally — always use localhost
  const { loadExistingSetupConfig } = await import("./setup.js");
  const envConfig = loadExistingSetupConfig();
  const botUrl = `http://localhost:${envConfig.PORT || "3978"}`;

  const settingsFile = path.join(homeDir, ".claude", "settings.json");
  const skillDestDir = path.join(homeDir, ".claude", "skills", "handoff");

  copyDirSync(skillSrcDir, skillDestDir);
  fs.writeFileSync(path.join(skillDestDir, ".version"), getPackageVersion());
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

  cleanupLegacyHooks();

  console.log("Uninstalled /handoff skill.");
}
