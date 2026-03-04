#!/usr/bin/env node
// Reads MICROSOFT_APP_ID from .env and packages manifest/ into teams-claude-bot.zip

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Parse .env
const env = {};
try {
  const raw = readFileSync(resolve(root, ".env"), "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) env[match[1].trim()] = match[2].trim();
  }
} catch {
  console.error("Error: .env file not found");
  process.exit(1);
}

const appId = env["MICROSOFT_APP_ID"];
if (!appId || appId === "your-app-id") {
  console.error("Error: MICROSOFT_APP_ID not set in .env");
  process.exit(1);
}

// Domain for tabs — from DEVTUNNEL_ID or BOT_DOMAIN env var
const tunnelId = env["DEVTUNNEL_ID"];
const botDomain = env["BOT_DOMAIN"] || (tunnelId ? `${tunnelId}-3978.devtunnels.ms` : "");
if (!botDomain) {
  console.warn("Warning: No BOT_DOMAIN or DEVTUNNEL_ID set — Voice Tab URL will need manual updating");
}

// Patch manifest.json
const manifestPath = resolve(root, "manifest", "manifest.json");
const manifest = readFileSync(manifestPath, "utf-8");
let patched = manifest
  .replace(/"id":\s*"YOUR_BOT_APP_ID"/, `"id": "${appId}"`)
  .replace(/"botId":\s*"YOUR_BOT_APP_ID"/, `"botId": "${appId}"`);

if (botDomain) {
  patched = patched.replace(/YOUR_DOMAIN/g, botDomain);
}

const tmpManifest = resolve(root, "manifest", "_manifest.json");
writeFileSync(tmpManifest, patched);

// Create zip
const zipPath = resolve(root, "teams-claude-bot.zip");
try {
  execSync(
    `powershell -Command "Compress-Archive -Path '${resolve(root, "manifest", "_manifest.json")}','${resolve(root, "manifest", "color.png")}','${resolve(root, "manifest", "outline.png")}' -DestinationPath '${zipPath}' -Force"`,
    { stdio: "inherit" }
  );
  // Rename _manifest.json to manifest.json inside zip isn't possible with simple compress,
  // so we use a temp approach via a temp dir
} finally {
  // Clean up temp file
  try { execSync(`del "${tmpManifest.replace(/\//g, "\\")}"`); } catch {}
}

// Better approach: copy to temp dir, rename, zip
import { cpSync, rmSync } from "fs";
const tmpDir = resolve(root, "_manifest_tmp");
mkdirSync(tmpDir, { recursive: true });
cpSync(resolve(root, "manifest", "color.png"), resolve(tmpDir, "color.png"));
cpSync(resolve(root, "manifest", "outline.png"), resolve(tmpDir, "outline.png"));
writeFileSync(resolve(tmpDir, "manifest.json"), patched);

execSync(
  `powershell -Command "Compress-Archive -Path '${tmpDir}\\*' -DestinationPath '${zipPath}' -Force"`,
  { stdio: "inherit" }
);
rmSync(tmpDir, { recursive: true });

console.log(`✓ Created ${zipPath} with App ID: ${appId}`);
