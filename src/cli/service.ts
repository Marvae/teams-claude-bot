import fs from "fs";
import os from "os";
import path from "path";
import {
  type Platform,
  projectDir,
  macLabel,
  winTaskName,
  linuxServiceName,
  macPlistPath,
  macLogPath,
  winLogPath,
  winErrLogPath,
  linuxLogPath,
  linuxUnitPath,
} from "./constants.js";
import { runCommand, capture, escapeSingleQuotes } from "./utils.js";

function makeMacPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${macLabel}</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${escapeSingleQuotes(path.join(projectDir, "scripts", "run.sh"))}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${escapeSingleQuotes(projectDir)}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${macLogPath}</string>
    <key>StandardErrorPath</key>
    <string>${macLogPath}</string>
</dict>
</plist>`;
}

function makeLinuxUnit(): string {
  return `[Unit]
Description=Teams Claude Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${path.join(projectDir, "scripts", "run.sh")}
WorkingDirectory=${projectDir}
Restart=on-failure
RestartSec=5
StandardOutput=append:${linuxLogPath}
StandardError=append:${linuxLogPath}

[Install]
WantedBy=default.target
`;
}

async function macInstallService(): Promise<void> {
  fs.mkdirSync(path.dirname(macPlistPath), { recursive: true });
  fs.writeFileSync(macPlistPath, makeMacPlist(), "utf8");
  console.log(`Wrote ${macPlistPath}`);

  await runCommand("launchctl", ["load", "-w", macPlistPath]);
  console.log("Loaded LaunchAgent. The bot will start now and on login.");
}

async function macUninstallService(): Promise<void> {
  if (fs.existsSync(macPlistPath)) {
    await runCommand("launchctl", ["unload", macPlistPath], {
      allowFailure: true,
    });
    fs.unlinkSync(macPlistPath);
    console.log(`Removed ${macPlistPath}`);
  }
}

async function macStartService(): Promise<void> {
  if (!fs.existsSync(macPlistPath)) {
    console.log(
      "LaunchAgent not installed. Run 'teams-bot install' first, which auto-starts.",
    );
    return;
  }

  // kickstart is the reliable way to force-start a KeepAlive agent.
  // On macOS 13+ the "system" UID domain is gui/<uid>.
  const uid = process.getuid?.() ?? 501;
  await runCommand("launchctl", ["kickstart", "-k", `gui/${uid}/${macLabel}`], {
    allowFailure: true,
  });
  console.log("Started.");
}

async function macStopService(): Promise<void> {
  await runCommand("launchctl", ["stop", macLabel], { allowFailure: true });
}

async function macStatus(): Promise<void> {
  const result = await runCommand("launchctl", ["list", macLabel], {
    stdio: "pipe",
    allowFailure: true,
  });
  if (result.code !== 0) {
    console.log("Service is not loaded.");
    return;
  }
  // Parse PID (first column on 2nd line of `launchctl list <label>`)
  const lines = result.stdout.split("\n");
  const pidLine = lines.find((l) => l.includes(macLabel));
  const pid = pidLine?.split(/\s+/)[0];
  console.log(
    pid && pid !== "-"
      ? `Service: RUNNING (pid ${pid})`
      : "Service: LOADED (not running)",
  );
}

async function getWindowsBashPath(): Promise<string> {
  // Try the common Git for Windows path first (works in all terminals)
  const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
  if (fs.existsSync(gitBash)) {
    return gitBash;
  }
  // Try to find bash via where.exe
  try {
    const where = await capture("where.exe", ["bash"]);
    const first = where.split(/\r?\n/)[0]?.trim();
    if (first && fs.existsSync(first)) {
      return first;
    }
  } catch {
    /* ignore */
  }
  throw new Error(
    "Could not find bash.exe. Install Git for Windows (https://git-scm.com) or add bash to PATH.",
  );
}

async function runPowerShell(
  script: string,
  opts?: { allowFailure?: boolean },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCommand(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { stdio: "pipe", ...opts },
  );
}

async function windowsStopService(): Promise<void> {
  // Stop the scheduled task (if running) + kill any leftover process
  await runPowerShell(
    `Stop-ScheduledTask -TaskName '${winTaskName}' -ErrorAction SilentlyContinue`,
    { allowFailure: true },
  );
  await runPowerShell(
    `Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq '' } | Stop-Process -Force -ErrorAction SilentlyContinue`,
    { allowFailure: true },
  );
}

async function windowsStartBackground(): Promise<void> {
  const bashPath = await getWindowsBashPath();
  const scriptPath = path
    .join(projectDir, "scripts", "run.sh")
    .replace(/\\/g, "/");
  await runPowerShell(
    `Start-Process -FilePath '${bashPath}' -ArgumentList '${scriptPath}' ` +
      `-WindowStyle Hidden ` +
      `-RedirectStandardOutput '${winLogPath}' ` +
      `-RedirectStandardError '${winErrLogPath}'`,
  );
}

async function windowsInstallService(): Promise<void> {
  const bashPath = await getWindowsBashPath();
  const scriptPath = path
    .join(projectDir, "scripts", "run.sh")
    .replace(/\\/g, "/");
  // Create a scheduled task that runs at logon and restarts on failure
  const xml = `
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <!-- PT1M is the minimum interval Windows Task Scheduler allows -->
  <Settings><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><AllowStartOnDemand>true</AllowStartOnDemand></Settings>
  <Actions><Exec><Command>${bashPath}</Command><Arguments>${scriptPath}</Arguments><WorkingDirectory>${projectDir}</WorkingDirectory></Exec></Actions>
</Task>`.trim();
  const tmpXml = path.join(os.tmpdir(), `${winTaskName}.xml`);
  fs.writeFileSync(tmpXml, xml, "utf8");
  const result = await runPowerShell(
    `Register-ScheduledTask -TaskName '${winTaskName}' -Xml (Get-Content '${tmpXml}' -Raw) -Force`,
    { allowFailure: true },
  );
  try {
    fs.unlinkSync(tmpXml);
  } catch {
    /* ignore */
  }

  if (result.code === 0) {
    await runPowerShell(`Start-ScheduledTask -TaskName '${winTaskName}'`);
    console.log(
      `Registered scheduled task "${winTaskName}". The bot will start now and on login.`,
    );
    return;
  }

  // Scheduled task registration failed — extract first meaningful line from stderr
  const firstLine = result.stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(
      (l) => l.length > 0 && !l.startsWith("At line:") && !l.startsWith("+"),
    );
  console.error("Failed to register scheduled task.");
  if (firstLine) console.error(`  ${firstLine}`);
  console.log("\nTry one of:");
  console.log("  1. Run as Administrator: teams-bot install");
  console.log("  2. Start without auto-login: teams-bot start");
  console.log("     (runs in background, but won't auto-start after reboot)");
}

async function windowsUninstallService(): Promise<void> {
  await windowsStopService();
  await runPowerShell(
    `Unregister-ScheduledTask -TaskName '${winTaskName}' -Confirm:$false -ErrorAction SilentlyContinue`,
    { allowFailure: true },
  );
  console.log(`Removed scheduled task "${winTaskName}".`);
}

async function windowsStartService(): Promise<void> {
  await windowsStartBackground();
}

async function windowsStatus(): Promise<void> {
  const result = await runPowerShell(
    `$t = Get-ScheduledTask -TaskName '${winTaskName}' -ErrorAction SilentlyContinue; ` +
      `if ($t) { ` +
      `  $info = $t | Get-ScheduledTaskInfo; ` +
      `  Write-Output "State: $($t.State)"; ` +
      `  Write-Output "LastRun: $($info.LastRunTime)"; ` +
      `  Write-Output "LastResult: $($info.LastTaskResult)"; ` +
      `  Write-Output "NextRun: $($info.NextRunTime)" ` +
      `} else { Write-Output 'NOT_INSTALLED' }`,
    { allowFailure: true },
  );

  const out = result.stdout.trim();
  if (out === "NOT_INSTALLED") {
    console.log("Service is not installed.");
    return;
  }

  for (const line of out.split("\n")) {
    const [key, ...rest] = line.split(": ");
    const value = rest.join(": ").trim();
    if (key === "State") {
      console.log(
        value === "Running"
          ? "Service: RUNNING"
          : `Service: ${value.toUpperCase()}`,
      );
    }
  }

  // Also check for any node process on port 3978
  const portCheck = await runPowerShell(
    `Get-NetTCPConnection -LocalPort 3978 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 OwningProcess`,
    { allowFailure: true },
  );
  if (portCheck.stdout.includes("OwningProcess")) {
    console.log("Port 3978: IN USE");
  }
}

async function linuxInstallService(): Promise<void> {
  fs.mkdirSync(path.dirname(linuxUnitPath), { recursive: true });
  fs.writeFileSync(linuxUnitPath, makeLinuxUnit(), "utf8");
  console.log(`Wrote ${linuxUnitPath}`);

  const logDir = path.dirname(linuxLogPath);
  fs.mkdirSync(logDir, { recursive: true });

  await runCommand("systemctl", ["--user", "daemon-reload"]);
  await runCommand("systemctl", [
    "--user",
    "enable",
    "--now",
    linuxServiceName,
  ]);
  console.log("Enabled and started systemd user service.");
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
  console.log("Removed systemd user service.");
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
  const result = await runCommand(
    "systemctl",
    ["--user", "is-active", linuxServiceName],
    { stdio: "pipe", allowFailure: true },
  );
  const state = result.stdout.trim();
  if (state === "active") {
    const pid = await runCommand(
      "systemctl",
      ["--user", "show", linuxServiceName, "--property=MainPID"],
      { stdio: "pipe", allowFailure: true },
    );
    const pidVal = pid.stdout.trim().split("=")[1];
    console.log(
      pidVal && pidVal !== "0"
        ? `Service: RUNNING (pid ${pidVal})`
        : "Service: RUNNING",
    );
  } else if (state === "inactive") {
    console.log("Service: STOPPED");
  } else if (state === "failed") {
    console.log("Service: FAILED");
  } else {
    console.log("Service is not installed.");
  }
}

export async function installService(platform: Platform): Promise<void> {
  switch (platform) {
    case "darwin":
      return macInstallService();
    case "win32":
      return windowsInstallService();
    case "linux":
      return linuxInstallService();
  }
}

export async function uninstallService(platform: Platform): Promise<void> {
  switch (platform) {
    case "darwin":
      return macUninstallService();
    case "win32":
      return windowsUninstallService();
    case "linux":
      return linuxUninstallService();
  }
}

export async function startService(platform: Platform): Promise<void> {
  switch (platform) {
    case "darwin":
      return macStartService();
    case "win32":
      return windowsStartService();
    case "linux":
      return linuxStartService();
  }
}

async function killPort(port: number): Promise<void> {
  const { stdout } = await runCommand("lsof", ["-ti", `:${port}`], {
    stdio: "pipe",
    allowFailure: true,
  });
  for (const pid of stdout.trim().split("\n").filter(Boolean)) {
    await runCommand("kill", ["-9", pid], { allowFailure: true });
  }
}

export async function stopService(platform: Platform): Promise<void> {
  switch (platform) {
    case "darwin":
      await macStopService();
      break;
    case "win32":
      await windowsStopService();
      break;
    case "linux":
      await linuxStopService();
      break;
  }

  // Fallback: kill anything still holding the port
  if (platform !== "win32") {
    await killPort(3978);
  }
}

export async function showStatus(platform: Platform): Promise<void> {
  switch (platform) {
    case "darwin":
      return macStatus();
    case "win32":
      return windowsStatus();
    case "linux":
      return linuxStatus();
  }
}

export function getLogPaths(platform: Platform): string[] {
  switch (platform) {
    case "darwin":
      return [macLogPath];
    case "win32":
      return [winLogPath, winErrLogPath];
    case "linux":
      return [linuxLogPath];
  }
}

export async function tailLogs(platform: Platform): Promise<void> {
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
