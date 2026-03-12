#!/usr/bin/env node

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { Command } from "commander";
import { randomBytes, randomUUID } from "crypto";
import {
  CANONICAL_ENV_PATH,
  HANDOFF_TOKEN_PATH,
  TEAMS_BOT_DATA_DIR,
} from "./paths.js";

declare const PKG_VERSION: string;

type Platform = "darwin" | "win32" | "linux";

const cliDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(cliDir, "..");
const homeDir = os.homedir();

// On Windows, npm is a .cmd file and needs the extension when shell is not used.
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const macLabel = "com.teams-claude-bot";
const winTaskName = "TeamsClaudeBot";
const linuxServiceName = "teams-claude-bot.service";

const macPlistPath = path.join(
  homeDir,
  "Library",
  "LaunchAgents",
  `${macLabel}.plist`,
);
const macLogPath = path.join(
  homeDir,
  "Library",
  "Logs",
  "teams-claude-bot.log",
);
const winLogPath = path.join(projectDir, "teams-bot.log");
const winErrLogPath = path.join(projectDir, "teams-bot-err.log");
const linuxLogPath = path.join(
  homeDir,
  ".local",
  "state",
  "teams-claude-bot.log",
);
const linuxUnitPath = path.join(
  homeDir,
  ".config",
  "systemd",
  "user",
  linuxServiceName,
);

function detectPlatform(): Platform {
  const current = os.platform();
  if (current === "darwin" || current === "win32" || current === "linux") {
    return current;
  }

  throw new Error(`Unsupported platform: ${current}`);
}

function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    stdio?: "inherit" | "pipe";
    allowFailure?: boolean;
    shell?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: options.stdio ?? "inherit",
      env: process.env,
      shell: options.shell ?? false,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          killed = true;
          child.kill();
        }, options.timeoutMs)
      : undefined;

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (killed) {
        if (options.allowFailure) {
          resolve({ code: 1, stdout, stderr: stderr + "\n(timed out)" });
          return;
        }
        reject(new Error(`Command timed out: ${command} ${args.join(" ")}`));
        return;
      }
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !options.allowFailure) {
        reject(new Error(`Command failed: ${command} ${args.join(" ")}`));
        return;
      }

      resolve({ code: exitCode, stdout, stderr });
    });
  });
}

async function capture(
  command: string,
  args: string[],
  cwd?: string,
): Promise<string> {
  const result = await runCommand(command, args, { stdio: "pipe", cwd });
  return result.stdout.trim();
}

async function prompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return "";
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function normalizeYesNo(input: string, defaultYes = false): boolean {
  if (!input) {
    return defaultYes;
  }

  return /^[Yy]/.test(input);
}

function ensureFile(filePath: string, fallback = "{}\n"): void {
  if (fs.existsSync(filePath)) {
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, fallback, "utf8");
}

function readJson(filePath: string): Record<string, unknown> {
  ensureFile(filePath);

  try {
    const content = fs.readFileSync(filePath, "utf8").trim();
    if (!content) {
      return {};
    }

    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJson(filePath: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureExecutable(filePath: string): void {
  try {
    fs.chmodSync(filePath, 0o755);
  } catch {
    // Ignore on filesystems/platforms that do not support chmod.
  }
}

function pathExistsAndNonEmpty(filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const content = fs.readFileSync(filePath, "utf8").trim();
  return content !== "" && content !== "{}";
}

async function runBuild(): Promise<void> {
  // Skip build when installed globally (dist/ already bundled, no package.json scripts)
  const pkgPath = path.join(projectDir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    return;
  }
  console.log("Building project...");
  await runCommand(npm, ["run", "build"], { cwd: projectDir, shell: true });
}

function escapeSingleQuotes(input: string): string {
  return input.replace(/'/g, "'\\''");
}

function makeMacPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${macLabel}</string>
    <key>WorkingDirectory</key>
    <string>${projectDir}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${path.join(projectDir, "scripts", "run.sh")}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${macLogPath}</string>
    <key>StandardErrorPath</key>
    <string>${macLogPath}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${process.env.PATH ?? ""}</string>
    </dict>
</dict>
</plist>
`;
}

function makeLinuxUnit(): string {
  const escapedRunPath = escapeSingleQuotes(
    path.join(projectDir, "scripts", "run.sh"),
  );
  const escapedLogPath = escapeSingleQuotes(linuxLogPath);
  const escapedProjectDir = projectDir.replace(/\\/g, "\\\\");

  return `[Unit]
Description=Teams Claude Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=${escapedProjectDir}
ExecStart=/bin/bash -lc '${escapedRunPath} >> ${escapedLogPath} 2>&1'
Restart=always
RestartSec=2
Environment=PATH=${process.env.PATH ?? ""}

[Install]
WantedBy=default.target
`;
}

async function macInstallService(): Promise<void> {
  fs.mkdirSync(path.dirname(macPlistPath), { recursive: true });
  fs.writeFileSync(macPlistPath, makeMacPlist(), "utf8");

  await runCommand("launchctl", ["unload", macPlistPath], {
    allowFailure: true,
  });
  await runCommand("launchctl", ["load", macPlistPath]);

  console.log(`Installed and started. Logs: ${macLogPath}`);
}

async function macUninstallService(): Promise<void> {
  await runCommand("launchctl", ["unload", macPlistPath], {
    allowFailure: true,
  });
  if (fs.existsSync(macPlistPath)) {
    fs.unlinkSync(macPlistPath);
  }
}

async function macStartService(): Promise<void> {
  const loaded = await runCommand("launchctl", ["list", macLabel], {
    stdio: "pipe",
    allowFailure: true,
  });
  if (loaded.code === 0) {
    console.log("Service is already running.");
    return;
  }

  const portCheck = await runCommand("lsof", ["-ti", ":3978"], {
    stdio: "pipe",
    allowFailure: true,
  });
  if (portCheck.stdout.trim()) {
    throw new Error(
      'Bot is already running. Try "teams-bot restart" or "teams-bot stop" first.',
    );
  }

  await runCommand("launchctl", ["load", macPlistPath]);
}

async function macStopService(): Promise<void> {
  await runCommand("launchctl", ["unload", macPlistPath], {
    allowFailure: true,
    stdio: "pipe",
  });
}

async function macStatus(): Promise<void> {
  const result = await runCommand("launchctl", ["list", macLabel], {
    stdio: "pipe",
    allowFailure: true,
  });
  if (result.code !== 0) {
    console.log("Not installed");
    return;
  }

  const pidMatch = result.stdout.match(/"PID"\s*=\s*(\d+)/);
  if (pidMatch?.[1]) {
    console.log(`Running (PID: ${pidMatch[1]})`);
  } else {
    console.log("Loaded but not running");
  }
}

async function getWindowsBashPath(): Promise<string> {
  const value = await capture("where", ["bash"]);
  const firstLine = value.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!firstLine) {
    throw new Error("Unable to find bash.exe. Install Git Bash first.");
  }

  return firstLine.trim();
}

async function runPowerShell(
  script: string,
  allowFailure = false,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCommand("powershell", ["-NoProfile", "-Command", script], {
    allowFailure,
    stdio: "pipe",
  });
}

async function windowsStopService(): Promise<void> {
  const script = `
(Get-NetTCPConnection -LocalPort 3978 -ErrorAction SilentlyContinue).OwningProcess |
  Select-Object -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
Get-Process devtunnel -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
`;
  await runPowerShell(script, true);
}

async function windowsStartBackground(): Promise<void> {
  const bashPath = await getWindowsBashPath();
  const runScript = path.join(projectDir, "scripts", "run.sh");

  const script =
    `
Start-Process -FilePath '${bashPath.replace(/'/g, "''")}' ` +
    `-ArgumentList '"${runScript.replace(/'/g, "''")}"' ` +
    `-WindowStyle Hidden ` +
    `-RedirectStandardOutput '${winLogPath.replace(/'/g, "''")}' ` +
    `-RedirectStandardError '${winErrLogPath.replace(/'/g, "''")}'
`;

  await runPowerShell(script);
}

async function windowsInstallService(): Promise<void> {
  await windowsStopService();
  await windowsStartBackground();

  const bashPath = await getWindowsBashPath();
  const runScript = path.join(projectDir, "scripts", "run.sh");

  const script = `
$action = New-ScheduledTaskAction -Execute '${bashPath.replace(/'/g, "''")}' -Argument '"${runScript.replace(/'/g, "''")}"' -WorkingDirectory '${projectDir.replace(/'/g, "''")}'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName '${winTaskName}' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
`;

  await runPowerShell(script);
  console.log(`Installed and started. Logs: ${winLogPath}`);
}

async function windowsUninstallService(): Promise<void> {
  await windowsStopService();
  await runPowerShell(
    `Unregister-ScheduledTask -TaskName '${winTaskName}' -Confirm:$false -ErrorAction SilentlyContinue`,
    true,
  );
}

async function windowsStartService(): Promise<void> {
  await windowsStartBackground();
}

async function windowsStatus(): Promise<void> {
  const runningOut = await runPowerShell(
    `
$portPid = (Get-NetTCPConnection -LocalPort 3978 -ErrorAction SilentlyContinue).OwningProcess | Select-Object -First 1
if ($portPid) { Write-Output "running:$portPid" } else { Write-Output 'running:no' }
`,
    true,
  );

  const taskOut = await runPowerShell(
    `
if (Get-ScheduledTask -TaskName '${winTaskName}' -ErrorAction SilentlyContinue) {
  Write-Output 'task:yes'
} else {
  Write-Output 'task:no'
}
`,
    true,
  );

  const runningMatch = runningOut.stdout.match(/running:(.+)/);
  const taskMatch = taskOut.stdout.match(/task:(yes|no)/);

  const running = runningMatch?.[1]?.trim();
  if (running && running !== "no") {
    console.log(`Running (port 3978, PID: ${running})`);
  } else {
    console.log("Not running");
  }

  if (taskMatch?.[1] === "yes") {
    console.log(`Auto-start: enabled (Task Scheduler: ${winTaskName})`);
  } else {
    console.log("Auto-start: not configured");
  }
}

async function linuxInstallService(): Promise<void> {
  fs.mkdirSync(path.dirname(linuxLogPath), { recursive: true });
  fs.mkdirSync(path.dirname(linuxUnitPath), { recursive: true });
  fs.writeFileSync(linuxUnitPath, makeLinuxUnit(), "utf8");

  await runCommand("systemctl", ["--user", "daemon-reload"]);
  await runCommand("systemctl", [
    "--user",
    "enable",
    "--now",
    linuxServiceName,
  ]);

  console.log(`Installed and started. Logs: ${linuxLogPath}`);
}

async function linuxUninstallService(): Promise<void> {
  await runCommand(
    "systemctl",
    ["--user", "disable", "--now", linuxServiceName],
    { allowFailure: true },
  );

  if (fs.existsSync(linuxUnitPath)) {
    fs.unlinkSync(linuxUnitPath);
  }

  await runCommand("systemctl", ["--user", "daemon-reload"], {
    allowFailure: true,
  });
}

async function linuxStartService(): Promise<void> {
  await runCommand("systemctl", ["--user", "start", linuxServiceName]);
}

async function linuxStopService(): Promise<void> {
  await runCommand("systemctl", ["--user", "stop", linuxServiceName], {
    allowFailure: true,
  });
}

async function linuxStatus(): Promise<void> {
  const active = await runCommand(
    "systemctl",
    ["--user", "is-active", linuxServiceName],
    {
      stdio: "pipe",
      allowFailure: true,
    },
  );
  const enabled = await runCommand(
    "systemctl",
    ["--user", "is-enabled", linuxServiceName],
    {
      stdio: "pipe",
      allowFailure: true,
    },
  );

  if (active.code === 0) {
    console.log("Running");
  } else if (enabled.code === 0) {
    console.log("Installed but not running");
  } else {
    console.log("Not installed");
  }

  if (enabled.code === 0) {
    console.log("Auto-start: enabled (systemd user service)");
  } else {
    console.log("Auto-start: not configured");
  }
}

async function installService(platform: Platform): Promise<void> {
  if (platform === "darwin") {
    await macInstallService();
    return;
  }

  if (platform === "win32") {
    await windowsInstallService();
    return;
  }

  await linuxInstallService();
}

async function uninstallService(platform: Platform): Promise<void> {
  if (platform === "darwin") {
    await macUninstallService();
    return;
  }

  if (platform === "win32") {
    await windowsUninstallService();
    return;
  }

  await linuxUninstallService();
}

async function startService(platform: Platform): Promise<void> {
  if (platform === "darwin") {
    await macStartService();
    return;
  }

  if (platform === "win32") {
    await windowsStartService();
    return;
  }

  await linuxStartService();
}

async function killPort(port: number): Promise<void> {
  const check = await runCommand("lsof", ["-ti", `:${port}`], {
    stdio: "pipe",
    allowFailure: true,
  });
  const pids = check.stdout.trim();
  if (!pids) return;
  for (const pid of pids.split(/\s+/)) {
    await runCommand("kill", [pid], { allowFailure: true, stdio: "pipe" });
  }
}

async function stopService(platform: Platform): Promise<void> {
  if (platform === "darwin") {
    await macStopService();
  } else if (platform === "win32") {
    await windowsStopService();
  } else {
    await linuxStopService();
  }

  // Fallback: kill anything still holding the port
  if (platform !== "win32") {
    await killPort(3978);
  }
}

async function showStatus(platform: Platform): Promise<void> {
  if (platform === "darwin") {
    await macStatus();
    return;
  }

  if (platform === "win32") {
    await windowsStatus();
    return;
  }

  await linuxStatus();
}

function getLogPaths(platform: Platform): string[] {
  if (platform === "darwin") {
    return [macLogPath];
  }

  if (platform === "win32") {
    return [winLogPath, winErrLogPath];
  }

  return [linuxLogPath];
}

async function tailLogs(platform: Platform): Promise<void> {
  const logPaths = getLogPaths(platform).filter((file) => fs.existsSync(file));
  if (logPaths.length === 0) {
    console.log(
      `No log file found. Expected one of: ${getLogPaths(platform).join(", ")}`,
    );
    return;
  }

  if (platform === "win32") {
    const script = `Get-Content -Path ${logPaths.map((logPath) => `'${logPath.replace(/'/g, "''")}'`).join(", ")} -Wait`;
    await runCommand("powershell", ["-NoProfile", "-Command", script]);
    return;
  }

  await runCommand("tail", ["-f", ...logPaths]);
}

function getConversationRefsPath(): string {
  return path.join(TEAMS_BOT_DATA_DIR, "conversation-refs.json");
}

async function maybeInstallSkillPrompt(): Promise<void> {
  const answer = await prompt(
    "Install /handoff skill for Claude Code? [Y/n]: ",
  );
  if (!normalizeYesNo(answer, true)) {
    console.log("Tip: Run 'teams-bot install-skill' later to enable /handoff.");
    return;
  }

  await installSkill();
}

function removeSessionStartHook(settings: Record<string, unknown>): boolean {
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

async function installSkill(): Promise<void> {
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

async function uninstallSkill(): Promise<void> {
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

function maskPassword(pw: string): string {
  if (pw.length <= 4) return "****";
  return pw.slice(0, 2) + "*".repeat(pw.length - 4) + pw.slice(-2);
}

interface SetupConfig {
  MICROSOFT_APP_ID: string;
  MICROSOFT_APP_PASSWORD: string;
  MICROSOFT_APP_TENANT_ID: string;
  CLAUDE_WORK_DIR: string;
  PORT: string;
  ALLOWED_USERS: string;
  DEVTUNNEL_ID: string;
  TEAMS_APP_ID: string;
}

function loadExistingSetupConfig(): Partial<SetupConfig> {
  const result: Partial<SetupConfig> = {};
  const paths = [CANONICAL_ENV_PATH, path.join(projectDir, ".env")];
  for (const envPath of paths) {
    try {
      const content = fs.readFileSync(envPath, "utf8");
      for (const line of content.split("\n")) {
        const match = line.match(/^([A-Z_]+)=(.*)$/);
        if (match) {
          const key = match[1] as keyof SetupConfig;
          if (key in result) continue; // first found wins
          const value = match[2].trim();
          if (value) (result as Record<string, string>)[key] = value;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return result;
}

function writeSetupEnv(config: SetupConfig): void {
  const lines = [
    `MICROSOFT_APP_ID=${config.MICROSOFT_APP_ID}`,
    `MICROSOFT_APP_PASSWORD=${config.MICROSOFT_APP_PASSWORD}`,
    `MICROSOFT_APP_TENANT_ID=${config.MICROSOFT_APP_TENANT_ID}`,
    `CLAUDE_WORK_DIR=${config.CLAUDE_WORK_DIR}`,
    `PORT=${config.PORT}`,
  ];
  if (config.ALLOWED_USERS) {
    lines.push(`ALLOWED_USERS=${config.ALLOWED_USERS}`);
  }
  if (config.DEVTUNNEL_ID) {
    lines.push(`DEVTUNNEL_ID=${config.DEVTUNNEL_ID}`);
  }
  lines.push(`TEAMS_APP_ID=${config.TEAMS_APP_ID}`);

  fs.mkdirSync(path.dirname(CANONICAL_ENV_PATH), { recursive: true });
  fs.writeFileSync(CANONICAL_ENV_PATH, lines.join("\n") + "\n", {
    mode: 0o600,
  });
}

function generateHandoffToken(): void {
  // Don't regenerate if one already exists
  try {
    const existing = fs.readFileSync(HANDOFF_TOKEN_PATH, "utf8").trim();
    if (existing) {
      console.log("✓ Handoff token exists");
      return;
    }
  } catch {
    /* doesn't exist yet */
  }

  const token = randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(HANDOFF_TOKEN_PATH), { recursive: true });
  fs.writeFileSync(HANDOFF_TOKEN_PATH, token, { mode: 0o600 });
  console.log("✓ Handoff token generated");
}

async function packageManifest(
  appId?: string,
  teamsAppId?: string,
): Promise<void> {
  const script = path.join(projectDir, "scripts", "package-manifest.mjs");
  const args = [script];
  if (appId) args.push(appId);
  if (teamsAppId) args.push(teamsAppId);
  await runCommand(process.execPath, args);
}

async function setupCommand(): Promise<void> {
  const existing = loadExistingSetupConfig();
  const hasExisting = Object.keys(existing).length > 0;

  console.log("\nTeams Claude Bot — Setup\n");
  if (hasExisting) {
    console.log(
      "Existing config detected. Press Enter to keep current values.\n",
    );
  }

  console.log("Azure Bot Configuration:");
  console.log("  (Find these in Azure Portal → App Registrations → your app)\n");
  const appId =
    (await prompt(
      existing.MICROSOFT_APP_ID
        ? `  Application (client) ID [${existing.MICROSOFT_APP_ID}]: `
        : "  Application (client) ID: ",
    )) ||
    existing.MICROSOFT_APP_ID ||
    "";

  const appPassword =
    (await prompt(
      existing.MICROSOFT_APP_PASSWORD
        ? `  Client Secret Value [${maskPassword(existing.MICROSOFT_APP_PASSWORD)}]: `
        : "  Client Secret Value: ",
    )) ||
    existing.MICROSOFT_APP_PASSWORD ||
    "";

  const tenantId =
    (await prompt(
      existing.MICROSOFT_APP_TENANT_ID
        ? `  Directory (tenant) ID [${existing.MICROSOFT_APP_TENANT_ID}]: `
        : "  Directory (tenant) ID: ",
    )) ||
    existing.MICROSOFT_APP_TENANT_ID ||
    "";

  if (!appId || !appPassword || !tenantId) {
    console.error("\nApp ID, Password, and Tenant ID are required.");
    process.exit(1);
  }

  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(appId)) {
    console.error(
      "\nApp ID must be a UUID (e.g. 12345678-abcd-1234-abcd-1234567890ab).",
    );
    console.error(
      "Find it in Azure Portal → App Registrations → Application (client) ID.",
    );
    process.exit(1);
  }

  console.log("\nBot Configuration:");
  const workDir =
    (await prompt(`  Work Directory [${existing.CLAUDE_WORK_DIR || "~"}]: `)) ||
    existing.CLAUDE_WORK_DIR ||
    "~";

  const port =
    (await prompt(`  Port [${existing.PORT || "3978"}]: `)) ||
    existing.PORT ||
    "3978";

  const allowedUsers =
    (await prompt(
      `  Allowed Users (comma-separated, blank = all)${existing.ALLOWED_USERS ? ` [${existing.ALLOWED_USERS}]` : ""}: `,
    )) ||
    existing.ALLOWED_USERS ||
    "";

  console.log("\nTunnel (optional):");
  const tunnelId =
    (await prompt(
      `  Dev Tunnel ID${existing.DEVTUNNEL_ID ? ` [${existing.DEVTUNNEL_ID}]` : ""}: `,
    )) ||
    existing.DEVTUNNEL_ID ||
    "";

  // Reuse existing Teams App ID or generate a new one
  const teamsAppId = existing.TEAMS_APP_ID || randomUUID();

  writeSetupEnv({
    MICROSOFT_APP_ID: appId,
    MICROSOFT_APP_PASSWORD: appPassword,
    MICROSOFT_APP_TENANT_ID: tenantId,
    CLAUDE_WORK_DIR: workDir,
    PORT: port,
    ALLOWED_USERS: allowedUsers,
    DEVTUNNEL_ID: tunnelId,
    TEAMS_APP_ID: teamsAppId,
  });
  console.log(`\n✓ Config saved to ${CANONICAL_ENV_PATH}`);

  generateHandoffToken();
  await packageManifest(appId, teamsAppId);

  console.log("");
  await maybeInstallSkillPrompt();

  console.log("\nNext steps:");
  console.log("  1. Upload teams-claude-bot.zip to Teams Admin Center");
  console.log("     (or import manifest/manifest.json in Teams Developer Portal)");
  console.log("  2. teams-bot install        Install as background service");
}

async function installCommand(): Promise<void> {
  const platform = detectPlatform();
  await runBuild();

  await installService(platform);

  if (!pathExistsAndNonEmpty(getConversationRefsPath())) {
    console.log("");
    console.log(
      "Important: Send any message to the bot in Teams to activate handoff.",
    );
    console.log(
      "This is a one-time setup so the bot can store your conversation ID.",
    );
  }
}

async function uninstallCommand(): Promise<void> {
  const platform = detectPlatform();
  await uninstallService(platform);
  console.log(
    "Uninstalled service/task. Run 'teams-bot uninstall-skill' to remove /handoff skill.",
  );
}

async function restartCommand(): Promise<void> {
  const platform = detectPlatform();
  await stopService(platform);
  await preflightCheck();
  await runBuild();
  await startService(platform);
  console.log("Restarted.");
}

async function preflightCheck(): Promise<void> {
  const cfg = loadExistingSetupConfig();
  const tunnelId = cfg.DEVTUNNEL_ID;
  if (!tunnelId) return;

  const result = await runCommand("devtunnel", ["token", tunnelId, "--scope", "host"], {
    stdio: "pipe",
    allowFailure: true,
  });

  if (result.code !== 0) {
    console.log("Tunnel auth expired. Logging in...");
    const login = await runCommand("devtunnel", ["user", "login"], {
      stdio: "inherit",
      allowFailure: true,
    });
    if (login.code !== 0) {
      throw new Error("devtunnel user login failed. Cannot start without tunnel auth.");
    }
    // Verify token works after login
    const retry = await runCommand("devtunnel", ["token", tunnelId, "--scope", "host"], {
      stdio: "pipe",
      allowFailure: true,
    });
    if (retry.code !== 0) {
      throw new Error("Tunnel auth still invalid after login. Check tunnel ownership.");
    }
    console.log("Tunnel auth OK.");
  }
}

async function startCommand(): Promise<void> {
  const platform = detectPlatform();
  await preflightCheck();
  await startService(platform);
  console.log("Started.");
}

async function stopCommand(): Promise<void> {
  const platform = detectPlatform();
  await stopService(platform);
  console.log("Stopped.");
}

async function statusCommand(): Promise<void> {
  const platform = detectPlatform();
  await showStatus(platform);
}

async function probe(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function getTunnelUrl(tunnelId: string): Promise<string | undefined> {
  const result = await runCommand("devtunnel", ["show", tunnelId], {
    stdio: "pipe",
    allowFailure: true,
    timeoutMs: 10000,
  });
  if (result.code !== 0) return undefined;
  const match = result.stdout.match(/(https:\/\/\S+devtunnels\.ms)\S*/);
  return match?.[1];
}

async function healthCommand(): Promise<void> {
  const platform = detectPlatform();
  await showStatus(platform);

  // Bot process check
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  let data: { uptimeSec?: number; session?: { active?: boolean; hasQuery?: boolean } };
  try {
    const res = await fetch("http://127.0.0.1:3978/healthz", { signal: controller.signal });
    if (!res.ok) {
      console.log(`Bot: FAIL (HTTP ${res.status})`);
      return;
    }
    data = await res.json();
  } catch {
    console.log("Bot: FAIL (not reachable on localhost:3978)");
    return;
  } finally {
    clearTimeout(timer);
  }
  const s = data.session;
  console.log(
    `Bot: OK · uptime ${data.uptimeSec ?? "?"}s · session ${s?.active ? "active" : "none"}${s?.hasQuery ? " (busy)" : ""}`,
  );

  // Tunnel check
  const cfg = loadExistingSetupConfig();
  if (!cfg.DEVTUNNEL_ID) {
    console.log("Tunnel: skipped (no DEVTUNNEL_ID)");
    return;
  }
  const tunnelUrl = await getTunnelUrl(cfg.DEVTUNNEL_ID);
  if (!tunnelUrl) {
    console.log("Tunnel: FAIL (could not resolve tunnel URL)");
    return;
  }
  const tunnelOk = await probe(`${tunnelUrl}/healthz`, 5000);
  console.log(tunnelOk ? "Tunnel: OK" : "Tunnel: FAIL (bot ok but tunnel unreachable)");
}

async function logsCommand(): Promise<void> {
  const platform = detectPlatform();
  await tailLogs(platform);
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("teams-bot")
    .description("Cross-platform service manager for teams-claude-bot")
    .version(PKG_VERSION);

  program
    .command("setup")
    .description("Interactive config setup")
    .action(async () => {
      await setupCommand();
    });

  program
    .command("package")
    .description("Generate teams-claude-bot.zip for Teams upload")
    .action(async () => {
      await packageManifest();
    });

  program
    .command("install")
    .description("Build + install auto-start service/task")
    .action(async () => {
      await installCommand();
    });

  program
    .command("uninstall")
    .description("Remove service/task")
    .action(async () => {
      await uninstallCommand();
    });

  program
    .command("start")
    .description("Start service")
    .action(async () => {
      await startCommand();
    });

  program
    .command("stop")
    .description("Stop service")
    .action(async () => {
      await stopCommand();
    });

  program
    .command("restart")
    .description("Rebuild + restart")
    .action(async () => {
      await restartCommand();
    });

  program
    .command("status")
    .description("Check service status")
    .action(async () => {
      await statusCommand();
    });

  program
    .command("health")
    .description("Check service status and /healthz endpoint")
    .action(async () => {
      await healthCommand();
    });

  program
    .command("logs")
    .description("Tail log file")
    .action(async () => {
      await logsCommand();
    });

  program
    .command("install-skill")
    .description("Install /handoff skill for Claude Code")
    .action(async () => {
      await installSkill();
    });

  program
    .command("uninstall-skill")
    .description("Remove /handoff skill")
    .action(async () => {
      await uninstallSkill();
    });

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
