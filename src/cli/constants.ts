import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

export type Platform = "darwin" | "win32" | "linux";

const cliDir = path.dirname(fileURLToPath(import.meta.url));
// esbuild bundles everything into dist/cli.js, so cliDir is <project>/dist
export const projectDir = path.resolve(cliDir, "..");
export const homeDir = os.homedir();

// On Windows, npm is a .cmd file and needs the extension when shell is not used.
export const npm = process.platform === "win32" ? "npm.cmd" : "npm";

export const macLabel = "com.teams-claude-bot";
export const winTaskName = "TeamsClaudeBot";
export const linuxServiceName = "teams-claude-bot.service";

export const macPlistPath = path.join(
  homeDir,
  "Library",
  "LaunchAgents",
  `${macLabel}.plist`,
);
export const macLogPath = path.join(
  homeDir,
  "Library",
  "Logs",
  "teams-claude-bot.log",
);
export const winLogPath = path.join(projectDir, "teams-bot.log");
export const winErrLogPath = path.join(projectDir, "teams-bot-err.log");
export const linuxLogPath = path.join(
  homeDir,
  ".local",
  "state",
  "teams-claude-bot.log",
);
export const linuxUnitPath = path.join(
  homeDir,
  ".config",
  "systemd",
  "user",
  linuxServiceName,
);

/** Resolve devtunnel executable – on Windows it may live outside Git Bash PATH */
let _devtunnelPath: string | undefined;
/** Clear cached devtunnel path (call after installing devtunnel) */
export function resetDevtunnelCache(): void {
  _devtunnelPath = undefined;
}
export function resolveDevtunnel(): string {
  if (_devtunnelPath) return _devtunnelPath;
  // Try plain "devtunnel" first (works if already in PATH)
  const name = process.platform === "win32" ? "devtunnel.exe" : "devtunnel";
  try {
    execFileSync(name, ["--version"], { stdio: "ignore" });
    _devtunnelPath = name;
    return name;
  } catch {
    // Not in PATH – check common Windows install locations
    if (process.platform === "win32") {
      const candidates = [
        path.join(
          homeDir,
          "AppData",
          "Local",
          "Microsoft",
          "WinGet",
          "Links",
          "devtunnel.exe",
        ),
        path.join(
          homeDir,
          "AppData",
          "Local",
          "Programs",
          "devtunnel",
          "devtunnel.exe",
        ),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          _devtunnelPath = p;
          return p;
        }
      }
    }
  }
  // Not found — return bare name but DON'T cache so we re-check after install
  return name;
}

export function detectPlatform(): Platform {
  const current = os.platform();
  if (current === "darwin" || current === "win32" || current === "linux") {
    return current;
  }

  throw new Error(`Unsupported platform: ${current}`);
}
