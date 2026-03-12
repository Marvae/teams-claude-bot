#!/usr/bin/env node
// Packages manifest/ into teams-claude-bot.zip with App ID from .env
// Cross-platform: uses zip on mac/linux, powershell on windows

import { readFileSync, writeFileSync, mkdtempSync, existsSync, unlinkSync, rmSync, copyFileSync, readdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { homedir, tmpdir } from "os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Parse .env files: canonical first, then project (project overrides)
function loadEnv() {
  const env = {};
  const paths = [
    join(homedir(), ".claude", "teams-bot", ".env"),
    resolve(root, ".env"),
  ];
  for (const envPath of paths) {
    try {
      const raw = readFileSync(envPath, "utf-8");
      for (const line of raw.split(/\r?\n/)) {
        const match = line.match(/^([^#=]+)=(.*)$/);
        if (match) env[match[1].trim()] = match[2].trim();
      }
    } catch {
      /* skip missing */
    }
  }
  return env;
}

const env = loadEnv();
const appId = process.argv[2] || env["MICROSOFT_APP_ID"];
if (!appId || appId === "your-app-id") {
  console.error("Error: MICROSOFT_APP_ID not found. Run 'teams-bot setup' first.");
  process.exit(1);
}

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!uuidRegex.test(appId)) {
  console.error(`Error: Invalid App ID "${appId}" — must be a UUID.`);
  console.error("Find it in Azure Portal → App Registrations → Application (client) ID.");
  console.error("Run 'teams-bot setup' to fix (press Enter to keep other values).");
  process.exit(1);
}

// Teams App ID (separate from Bot App ID)
const teamsAppId = process.argv[3] || env["TEAMS_APP_ID"];
if (!teamsAppId || !uuidRegex.test(teamsAppId)) {
  console.error("Error: TEAMS_APP_ID not found. Run 'teams-bot setup' first.");
  process.exit(1);
}

// Patch manifest template
const manifestDir = resolve(root, "manifest");
const template = readFileSync(resolve(manifestDir, "manifest.json"), "utf-8");
const patched = template
  .replace(/YOUR_TEAMS_APP_ID/g, teamsAppId)
  .replace(/YOUR_BOT_APP_ID/g, appId);

// Build in temp dir to avoid modifying tracked files
const tmpDir = mkdtempSync(join(tmpdir(), "manifest-"));
const outPath = resolve(process.cwd(), "teams-claude-bot.zip");

try {
  writeFileSync(join(tmpDir, "manifest.json"), patched);
  for (const file of ["color.png", "outline.png"]) {
    const src = resolve(manifestDir, file);
    if (existsSync(src)) copyFileSync(src, join(tmpDir, file));
  }

  if (existsSync(outPath)) unlinkSync(outPath);

  if (process.platform === "win32") {
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${tmpDir.replace(/'/g, "''")}\\*' -DestinationPath '${outPath.replace(/'/g, "''")}' -Force"`,
      { stdio: "inherit" },
    );
  } else {
    const files = readdirSync(tmpDir).map((f) => join(tmpDir, f));
    execSync(`zip -j '${outPath}' ${files.map((f) => `'${f}'`).join(" ")}`, {
      stdio: "inherit",
    });
  }

  console.log(`✓ Created teams-claude-bot.zip (App ID: ${appId})`);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
