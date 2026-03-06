#!/usr/bin/env node

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { Command } from 'commander';

type Platform = 'darwin' | 'win32' | 'linux';

const cliDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(cliDir, '..');
const homeDir = os.homedir();

// On Windows, npm is a .cmd file and needs the extension when shell is not used.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const macLabel = 'com.teams-claude-bot';
const winTaskName = 'TeamsClaudeBot';
const linuxServiceName = 'teams-claude-bot.service';

const macPlistPath = path.join(homeDir, 'Library', 'LaunchAgents', `${macLabel}.plist`);
const macLogPath = path.join(homeDir, 'Library', 'Logs', 'teams-claude-bot.log');
const winLogPath = path.join(projectDir, 'teams-bot.log');
const winErrLogPath = path.join(projectDir, 'teams-bot-err.log');
const linuxLogPath = path.join(homeDir, '.local', 'state', 'teams-claude-bot.log');
const linuxUnitPath = path.join(homeDir, '.config', 'systemd', 'user', linuxServiceName);

function detectPlatform(): Platform {
  const current = os.platform();
  if (current === 'darwin' || current === 'win32' || current === 'linux') {
    return current;
  }

  throw new Error(`Unsupported platform: ${current}`);
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; stdio?: 'inherit' | 'pipe'; allowFailure?: boolean; shell?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: options.stdio ?? 'inherit',
      env: process.env,
      shell: options.shell ?? false,
    });

    let stdout = '';
    let stderr = '';

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !options.allowFailure) {
        reject(new Error(`Command failed: ${command} ${args.join(' ')}`));
        return;
      }

      resolve({ code: exitCode, stdout, stderr });
    });
  });
}

async function capture(command: string, args: string[], cwd?: string): Promise<string> {
  const result = await runCommand(command, args, { stdio: 'pipe', cwd });
  return result.stdout.trim();
}

async function prompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return '';
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

function ensureFile(filePath: string, fallback = '{}\n'): void {
  if (fs.existsSync(filePath)) {
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, fallback, 'utf8');
}

function readHandoffTokenFromEnv(envPath: string): string | undefined {
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const match = content.match(/^HANDOFF_TOKEN=(.+)$/m);
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function readJson(filePath: string): Record<string, unknown> {
  ensureFile(filePath);

  try {
    const content = fs.readFileSync(filePath, 'utf8').trim();
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
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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

  const content = fs.readFileSync(filePath, 'utf8').trim();
  return content !== '' && content !== '{}';
}

async function runBuild(): Promise<void> {
  console.log('Building project...');
  await runCommand(npm, ['run', 'build'], { cwd: projectDir, shell: true });
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
        <string>${path.join(projectDir, 'scripts', 'run.sh')}</string>
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
        <string>${process.env.PATH ?? ''}</string>
    </dict>
</dict>
</plist>
`;
}

function makeLinuxUnit(): string {
  const escapedRunPath = escapeSingleQuotes(path.join(projectDir, 'scripts', 'run.sh'));
  const escapedLogPath = escapeSingleQuotes(linuxLogPath);
  const escapedProjectDir = projectDir.replace(/\\/g, '\\\\');

  return `[Unit]
Description=Teams Claude Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=${escapedProjectDir}
ExecStart=/bin/bash -lc '${escapedRunPath} >> ${escapedLogPath} 2>&1'
Restart=always
RestartSec=2
Environment=PATH=${process.env.PATH ?? ''}

[Install]
WantedBy=default.target
`;
}

async function macInstallService(): Promise<void> {
  fs.mkdirSync(path.dirname(macPlistPath), { recursive: true });
  fs.writeFileSync(macPlistPath, makeMacPlist(), 'utf8');

  await runCommand('launchctl', ['unload', macPlistPath], { allowFailure: true });
  await runCommand('launchctl', ['load', macPlistPath]);

  console.log(`Installed and started. Logs: ${macLogPath}`);
}

async function macUninstallService(): Promise<void> {
  await runCommand('launchctl', ['unload', macPlistPath], { allowFailure: true });
  if (fs.existsSync(macPlistPath)) {
    fs.unlinkSync(macPlistPath);
  }
}

async function macStartService(): Promise<void> {
  const loaded = await runCommand('launchctl', ['list', macLabel], { stdio: 'pipe', allowFailure: true });
  if (loaded.code === 0) {
    console.log('Service is already running.');
    return;
  }

  const portCheck = await runCommand('lsof', ['-ti', ':3978'], { stdio: 'pipe', allowFailure: true });
  if (portCheck.stdout.trim()) {
    throw new Error('Bot is already running. Try "teams-bot restart" or "teams-bot stop" first.');
  }

  await runCommand('launchctl', ['load', macPlistPath]);
}

async function macStopService(): Promise<void> {
  await runCommand('launchctl', ['unload', macPlistPath], { allowFailure: true, stdio: 'pipe' });
}

async function macStatus(): Promise<void> {
  const result = await runCommand('launchctl', ['list', macLabel], { stdio: 'pipe', allowFailure: true });
  if (result.code !== 0) {
    console.log('Not installed');
    return;
  }

  const pidMatch = result.stdout.match(/"PID"\s*=\s*(\d+)/);
  if (pidMatch?.[1]) {
    console.log(`Running (PID: ${pidMatch[1]})`);
  } else {
    console.log('Loaded but not running');
  }
}

async function getWindowsBashPath(): Promise<string> {
  const value = await capture('where', ['bash']);
  const firstLine = value.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!firstLine) {
    throw new Error('Unable to find bash.exe. Install Git Bash first.');
  }

  return firstLine.trim();
}

async function runPowerShell(script: string, allowFailure = false): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCommand('powershell', ['-NoProfile', '-Command', script], { allowFailure, stdio: 'pipe' });
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
  const runScript = path.join(projectDir, 'scripts', 'run.sh');

  const script = `
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
  const runScript = path.join(projectDir, 'scripts', 'run.sh');

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
  await runPowerShell(`Unregister-ScheduledTask -TaskName '${winTaskName}' -Confirm:$false -ErrorAction SilentlyContinue`, true);
}

async function windowsStartService(): Promise<void> {
  await windowsStartBackground();
}

async function windowsStatus(): Promise<void> {
  const runningOut = await runPowerShell(`
$portPid = (Get-NetTCPConnection -LocalPort 3978 -ErrorAction SilentlyContinue).OwningProcess | Select-Object -First 1
if ($portPid) { Write-Output "running:$portPid" } else { Write-Output 'running:no' }
`, true);

  const taskOut = await runPowerShell(`
if (Get-ScheduledTask -TaskName '${winTaskName}' -ErrorAction SilentlyContinue) {
  Write-Output 'task:yes'
} else {
  Write-Output 'task:no'
}
`, true);

  const runningMatch = runningOut.stdout.match(/running:(.+)/);
  const taskMatch = taskOut.stdout.match(/task:(yes|no)/);

  const running = runningMatch?.[1]?.trim();
  if (running && running !== 'no') {
    console.log(`Running (port 3978, PID: ${running})`);
  } else {
    console.log('Not running');
  }

  if (taskMatch?.[1] === 'yes') {
    console.log(`Auto-start: enabled (Task Scheduler: ${winTaskName})`);
  } else {
    console.log('Auto-start: not configured');
  }
}

async function linuxInstallService(): Promise<void> {
  fs.mkdirSync(path.dirname(linuxLogPath), { recursive: true });
  fs.mkdirSync(path.dirname(linuxUnitPath), { recursive: true });
  fs.writeFileSync(linuxUnitPath, makeLinuxUnit(), 'utf8');

  await runCommand('systemctl', ['--user', 'daemon-reload']);
  await runCommand('systemctl', ['--user', 'enable', '--now', linuxServiceName]);

  console.log(`Installed and started. Logs: ${linuxLogPath}`);
}

async function linuxUninstallService(): Promise<void> {
  await runCommand('systemctl', ['--user', 'disable', '--now', linuxServiceName], { allowFailure: true });

  if (fs.existsSync(linuxUnitPath)) {
    fs.unlinkSync(linuxUnitPath);
  }

  await runCommand('systemctl', ['--user', 'daemon-reload'], { allowFailure: true });
}

async function linuxStartService(): Promise<void> {
  await runCommand('systemctl', ['--user', 'start', linuxServiceName]);
}

async function linuxStopService(): Promise<void> {
  await runCommand('systemctl', ['--user', 'stop', linuxServiceName], { allowFailure: true });
}

async function linuxStatus(): Promise<void> {
  const active = await runCommand('systemctl', ['--user', 'is-active', linuxServiceName], {
    stdio: 'pipe',
    allowFailure: true,
  });
  const enabled = await runCommand('systemctl', ['--user', 'is-enabled', linuxServiceName], {
    stdio: 'pipe',
    allowFailure: true,
  });

  if (active.code === 0) {
    console.log('Running');
  } else if (enabled.code === 0) {
    console.log('Installed but not running');
  } else {
    console.log('Not installed');
  }

  if (enabled.code === 0) {
    console.log('Auto-start: enabled (systemd user service)');
  } else {
    console.log('Auto-start: not configured');
  }
}

async function installService(platform: Platform): Promise<void> {
  if (platform === 'darwin') {
    await macInstallService();
    return;
  }

  if (platform === 'win32') {
    await windowsInstallService();
    return;
  }

  await linuxInstallService();
}

async function uninstallService(platform: Platform): Promise<void> {
  if (platform === 'darwin') {
    await macUninstallService();
    return;
  }

  if (platform === 'win32') {
    await windowsUninstallService();
    return;
  }

  await linuxUninstallService();
}

async function startService(platform: Platform): Promise<void> {
  if (platform === 'darwin') {
    await macStartService();
    return;
  }

  if (platform === 'win32') {
    await windowsStartService();
    return;
  }

  await linuxStartService();
}

async function stopService(platform: Platform): Promise<void> {
  if (platform === 'darwin') {
    await macStopService();
    return;
  }

  if (platform === 'win32') {
    await windowsStopService();
    return;
  }

  await linuxStopService();
}

async function showStatus(platform: Platform): Promise<void> {
  if (platform === 'darwin') {
    await macStatus();
    return;
  }

  if (platform === 'win32') {
    await windowsStatus();
    return;
  }

  await linuxStatus();
}

function getLogPaths(platform: Platform): string[] {
  if (platform === 'darwin') {
    return [macLogPath];
  }

  if (platform === 'win32') {
    return [winLogPath, winErrLogPath];
  }

  return [linuxLogPath];
}

async function tailLogs(platform: Platform): Promise<void> {
  const logPaths = getLogPaths(platform).filter((file) => fs.existsSync(file));
  if (logPaths.length === 0) {
    console.log(`No log file found. Expected one of: ${getLogPaths(platform).join(', ')}`);
    return;
  }

  if (platform === 'win32') {
    const script = `Get-Content -Path ${logPaths.map((logPath) => `'${logPath.replace(/'/g, "''")}'`).join(', ')} -Wait`;
    await runCommand('powershell', ['-NoProfile', '-Command', script]);
    return;
  }

  await runCommand('tail', ['-f', ...logPaths]);
}

function getConversationRefsPath(): string {
  return path.join(projectDir, '.conversation-refs.json');
}

async function maybeInstallSkillPrompt(): Promise<void> {
  const answer = await prompt('Install /handoff skill for Claude Code? [Y/n]: ');
  if (!normalizeYesNo(answer, true)) {
    console.log("Tip: Run 'teams-bot install-skill' later to enable /handoff.");
    return;
  }

  await installSkill();
}

function removeSessionStartHook(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object') {
    return false;
  }

  const hooksObj = hooks as Record<string, unknown>;
  const sessionStart = hooksObj.SessionStart;
  if (!Array.isArray(sessionStart)) {
    return false;
  }

  const filteredGroups = sessionStart
    .map((group) => {
      if (!group || typeof group !== 'object') {
        return group;
      }

      const groupObj = group as Record<string, unknown>;
      const groupHooks = Array.isArray(groupObj.hooks) ? groupObj.hooks : [];
      const filteredHooks = groupHooks.filter((hook) => {
        if (!hook || typeof hook !== 'object') {
          return true;
        }

        const hookObj = hook as Record<string, unknown>;
        const command = hookObj.command;
        return typeof command !== 'string' || !command.includes('session-start.sh');
      });

      return { ...groupObj, hooks: filteredHooks };
    })
    .filter((group) => {
      if (!group || typeof group !== 'object') {
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

function upsertSessionStartHook(settings: Record<string, unknown>, hookCommand: string): boolean {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const sessionStart = (hooks.SessionStart ?? []) as Array<Record<string, unknown>>;

  const exists = sessionStart.some((group) => {
    const groupHooks = Array.isArray(group.hooks) ? group.hooks : [];
    return groupHooks.some((hook) => {
      if (!hook || typeof hook !== 'object') {
        return false;
      }

      const command = (hook as Record<string, unknown>).command;
      return typeof command === 'string' && command.includes('session-start.sh');
    });
  });

  if (exists) {
    settings.hooks = hooks;
    return false;
  }

  sessionStart.push({
    hooks: [
      {
        type: 'command',
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

  const files = ['SKILL.md', 'get-session-id.sh'];
  for (const fileName of files) {
    const source = path.join(sourceDir, fileName);
    const destination = path.join(destinationDir, fileName);
    fs.copyFileSync(source, destination);
    ensureExecutable(destination);
  }
}

async function installSkill(): Promise<void> {
  const skillSrcDir = path.join(projectDir, '.claude', 'skills', 'handoff');
  const skillSrc = path.join(skillSrcDir, 'SKILL.md');
  const sessionHook = path.join(projectDir, '.claude', 'hooks', 'session-start.sh');

  if (!fs.existsSync(skillSrc)) {
    throw new Error(`Skill file not found at ${skillSrc}`);
  }

  console.log('\nTeams Bot - Install /handoff\n');
  console.log('Where to install?');
  console.log('  1) Global (all projects)   ~/.claude/');
  console.log('  2) This project only       .claude/\n');

  const scopeChoice = (await prompt('Choose [1]: ')) || '1';
  const botUrlInput = await prompt('URL [http://localhost:3978]: ');
  const botUrl = botUrlInput || 'http://localhost:3978';

  let settingsFile = path.join(projectDir, '.claude', 'settings.json');
  let skillDestDir = path.join(projectDir, '.claude', 'skills', 'handoff');

  if (scopeChoice === '1') {
    settingsFile = path.join(homeDir, '.claude', 'settings.json');
    skillDestDir = path.join(homeDir, '.claude', 'skills', 'handoff');
  }

  console.log('\nSummary:');
  console.log(`  Install to: ${scopeChoice === '1' ? '~/.claude/ (global)' : '.claude/ (project)'}`);
  console.log(`  Bot URL:    ${botUrl}\n`);

  const confirm = await prompt('Proceed? [Y/n]: ');
  if (!normalizeYesNo(confirm, true)) {
    console.log('Cancelled.');
    return;
  }

  installSkillFiles(skillDestDir, skillSrcDir);
  console.log('✓ Skill installed');

  ensureExecutable(sessionHook);

  const hookCommand = process.platform === 'win32' ? sessionHook.replace(/\\/g, '/') : sessionHook;
  const settings = readJson(settingsFile);

  const hookAdded = upsertSessionStartHook(settings, hookCommand);
  if (hookAdded) {
    console.log('✓ Hook installed');
  } else {
    console.log('✓ Hook already configured');
  }

  const env = ((settings.env as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
  if (botUrl !== 'http://localhost:3978') {
    env.TEAMS_BOT_URL = botUrl;
    settings.env = env;
    console.log('✓ Bot URL saved');
  } else if (env.TEAMS_BOT_URL) {
    delete env.TEAMS_BOT_URL;
  }

  // Save HANDOFF_TOKEN to settings.json so it's available in all projects,
  // not just when ~/.bashrc is sourced (Claude Code uses non-interactive shells).
  const botEnvPath = path.join(projectDir, '.env');
  const handoffToken = readHandoffTokenFromEnv(botEnvPath);
  if (handoffToken) {
    env.HANDOFF_TOKEN = handoffToken;
    settings.env = env;
    console.log('✓ Handoff token saved');
  }

  if (settings.env && Object.keys(settings.env as object).length === 0) {
    delete settings.env;
  }

  writeJson(settingsFile, settings);

  console.log('\nDone! Restart Claude Code, then use /handoff.');
}

async function uninstallSkill(): Promise<void> {
  const skillDirs = [
    path.join(homeDir, '.claude', 'skills', 'handoff'),
    path.join(projectDir, '.claude', 'skills', 'handoff'),
  ];

  for (const skillDir of skillDirs) {
    if (fs.existsSync(skillDir)) {
      fs.rmSync(skillDir, { recursive: true, force: true });
      console.log(`Removed skill from ${skillDir}`);
    }
  }

  const settingsFiles = [
    path.join(homeDir, '.claude', 'settings.json'),
    path.join(projectDir, '.claude', 'settings.json'),
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

  console.log('Uninstalled /handoff skill and hook.');
}

async function installCommand(): Promise<void> {
  const platform = detectPlatform();
  await runBuild();

  await installService(platform);

  if (!pathExistsAndNonEmpty(getConversationRefsPath())) {
    console.log('');
    console.log('Important: Send any message to the bot in Teams to activate handoff.');
    console.log('This is a one-time setup so the bot can store your conversation ID.');
  }

  console.log('');
  await maybeInstallSkillPrompt();
}

async function uninstallCommand(): Promise<void> {
  const platform = detectPlatform();
  await uninstallService(platform);
  console.log("Uninstalled service/task. Run 'teams-bot uninstall-skill' to remove /handoff skill.");
}

async function syncHandoffToken(): Promise<void> {
  const botEnvPath = path.join(projectDir, '.env');
  let token: string | undefined;
  for (let i = 0; i < 6; i++) {
    token = readHandoffTokenFromEnv(botEnvPath);
    if (token) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (!token) {
    console.log('⚠ Could not read HANDOFF_TOKEN from .env — run teams-bot setup if /handoff fails');
    return;
  }

  const settingsFile = path.join(homeDir, '.claude', 'settings.json');
  const settings = readJson(settingsFile);
  const env = ((settings.env as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
  env.HANDOFF_TOKEN = token;
  settings.env = env;
  writeJson(settingsFile, settings);
  console.log('✓ Handoff token synced');
}

async function restartCommand(): Promise<void> {
  const platform = detectPlatform();
  await stopService(platform);
  await runBuild();
  await startService(platform);
  await syncHandoffToken();
  console.log('Restarted.');
}

async function startCommand(): Promise<void> {
  const platform = detectPlatform();
  await startService(platform);
  console.log('Started.');
}

async function stopCommand(): Promise<void> {
  const platform = detectPlatform();
  await stopService(platform);
  console.log('Stopped.');
}

async function statusCommand(): Promise<void> {
  const platform = detectPlatform();
  await showStatus(platform);
}

async function logsCommand(): Promise<void> {
  const platform = detectPlatform();
  await tailLogs(platform);
}

async function main(): Promise<void> {
  const program = new Command();

  program.name('teams-bot').description('Cross-platform service manager for teams-claude-bot').version('1.0.0');

  program.command('install').description('Build + install auto-start service/task').action(async () => {
    await installCommand();
  });

  program.command('uninstall').description('Remove service/task').action(async () => {
    await uninstallCommand();
  });

  program.command('start').description('Start service').action(async () => {
    await startCommand();
  });

  program.command('stop').description('Stop service').action(async () => {
    await stopCommand();
  });

  program.command('restart').description('Rebuild + restart').action(async () => {
    await restartCommand();
  });

  program.command('status').description('Check service status').action(async () => {
    await statusCommand();
  });

  program.command('logs').description('Tail log file').action(async () => {
    await logsCommand();
  });

  program.command('install-skill').description('Install /handoff skill for Claude Code').action(async () => {
    await installSkill();
  });

  program.command('uninstall-skill').description('Remove /handoff skill').action(async () => {
    await uninstallSkill();
  });

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
