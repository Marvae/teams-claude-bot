import fs from "fs";
import path from "path";
import { TEAMS_BOT_DATA_DIR } from "../paths.js";
import { projectDir, homeDir } from "./constants.js";
import {
  prompt,
  normalizeYesNo,
  readJson,
  writeJson,
  ensureExecutable,
} from "./utils.js";

export function getConversationRefsPath(): string {
  return path.join(TEAMS_BOT_DATA_DIR, "conversation-refs.json");
}

export async function maybeInstallSkillPrompt(): Promise<void> {
  const answer = await prompt(
    "Install /handoff skill for Claude Code? [Y/n]: ",
  );
  if (!normalizeYesNo(answer, true)) {
    console.log("Tip: Run 'teams-bot install-skill' later to enable /handoff.");
    return;
  }

  await installSkill();
}

export function removeSessionStartHook(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object") {
    return false;
  }

  const hooksObj = hooks as Record<string, unknown>;
  const sessionStart = hooksObj.SessionStart;
  if (!Array.isArray(sessionStart)) {
    return false;
  }

  const filteredGroups = sessionStart
    .map((group) => {
      if (!group || typeof group !== "object") {
        return group;
      }

      const groupObj = group as Record<string, unknown>;
      const groupHooks = Array.isArray(groupObj.hooks) ? groupObj.hooks : [];
      const filteredHooks = groupHooks.filter((hook) => {
        if (!hook || typeof hook !== "object") {
          return true;
        }

        const hookObj = hook as Record<string, unknown>;
        const command = hookObj.command;
        return (
          typeof command !== "string" || !command.includes("session-start.sh")
        );
      });

      return { ...groupObj, hooks: filteredHooks };
    })
    .filter((group) => {
      if (!group || typeof group !== "object") {
        return true;
      }

      const groupObj = group as Record<string, unknown>;
      return Array.isArray(groupObj.hooks) && groupObj.hooks.length > 0;
    });

  if (filteredGroups.length === sessionStart.length) {
    return false;
  }

  if (filteredGroups.length === 0) {
    delete hooksObj.SessionStart;
  } else {
    hooksObj.SessionStart = filteredGroups;
  }

  if (Object.keys(hooksObj).length === 0) {
    delete settings.hooks;
  }

  return true;
}

function upsertSessionStartHook(
  settings: Record<string, unknown>,
  hookCommand: string,
): boolean {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const sessionStart = (hooks.SessionStart ?? []) as Array<
    Record<string, unknown>
  >;

  const exists = sessionStart.some((group) => {
    const groupHooks = Array.isArray(group.hooks) ? group.hooks : [];
    return groupHooks.some((hook) => {
      if (!hook || typeof hook !== "object") {
        return false;
      }

      const command = (hook as Record<string, unknown>).command;
      return (
        typeof command === "string" && command.includes("session-start.sh")
      );
    });
  });

  if (exists) {
    settings.hooks = hooks;
    return false;
  }

  sessionStart.push({
    hooks: [
      {
        type: "command",
        command: hookCommand,
      },
    ],
  });

  hooks.SessionStart = sessionStart;
  settings.hooks = hooks;
  return true;
}

function installSkillFiles(destinationDir: string, sourceDir: string): void {
  fs.mkdirSync(destinationDir, { recursive: true });

  const files = ["SKILL.md", "get-session-id.sh"];
  for (const fileName of files) {
    const source = path.join(sourceDir, fileName);
    const destination = path.join(destinationDir, fileName);
    fs.copyFileSync(source, destination);
    ensureExecutable(destination);
  }
}

export async function installSkill(): Promise<void> {
  const skillSrcDir = path.join(projectDir, ".claude", "skills", "handoff");
  const skillSrc = path.join(skillSrcDir, "SKILL.md");
  const sessionHook = path.join(
    projectDir,
    ".claude",
    "hooks",
    "session-start.sh",
  );

  if (!fs.existsSync(skillSrc)) {
    throw new Error(`Skill file not found at ${skillSrc}`);
  }

  console.log("\nTeams Bot - Install /handoff\n");
  console.log("Where to install?");
  console.log("  1) Global (all projects)   ~/.claude/");
  console.log("  2) This project only       .claude/\n");

  const scopeChoice = (await prompt("Choose [1]: ")) || "1";
  const botUrlInput = await prompt("URL [http://localhost:3978]: ");
  const botUrl = botUrlInput || "http://localhost:3978";

  let settingsFile = path.join(projectDir, ".claude", "settings.json");
  let skillDestDir = path.join(projectDir, ".claude", "skills", "handoff");

  if (scopeChoice === "1") {
    settingsFile = path.join(homeDir, ".claude", "settings.json");
    skillDestDir = path.join(homeDir, ".claude", "skills", "handoff");
  }

  console.log("\nSummary:");
  console.log(
    `  Install to: ${scopeChoice === "1" ? "~/.claude/ (global)" : ".claude/ (project)"}`,
  );
  console.log(`  Bot URL:    ${botUrl}\n`);

  const confirm = await prompt("Proceed? [Y/n]: ");
  if (!normalizeYesNo(confirm, true)) {
    console.log("Cancelled.");
    return;
  }

  installSkillFiles(skillDestDir, skillSrcDir);
  console.log("✓ Skill installed");

  ensureExecutable(sessionHook);

  const hookCommand =
    process.platform === "win32"
      ? sessionHook.replace(/\\/g, "/")
      : sessionHook;
  const settings = readJson(settingsFile);

  const hookAdded = upsertSessionStartHook(settings, hookCommand);
  if (hookAdded) {
    console.log("✓ Hook installed");
  } else {
    console.log("✓ Hook already configured");
  }

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

  const settingsFiles = [
    path.join(homeDir, ".claude", "settings.json"),
    path.join(process.cwd(), ".claude", "settings.json"),
  ];

  for (const settingsFile of settingsFiles) {
    if (!fs.existsSync(settingsFile)) {
      continue;
    }

    const settings = readJson(settingsFile);
    const removed = removeSessionStartHook(settings);

    if (removed) {
      writeJson(settingsFile, settings);
      console.log(`Removed hook from ${settingsFile}`);
    }
  }

  console.log("Uninstalled /handoff skill and hook.");
}
