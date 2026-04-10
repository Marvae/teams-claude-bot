import fs from "fs";
import { type Platform, detectPlatform, resolveDevtunnel } from "./constants.js";
import { runCommand, runBuild, pathExistsAndNonEmpty } from "./utils.js";
import {
  installService,
  uninstallService,
  startService,
  stopService,
  showStatus,
  tailLogs,
} from "./service.js";
import { getConversationRefsPath } from "./skill.js";
import { loadExistingSetupConfig } from "./setup.js";

async function preflightCheck(): Promise<void> {
  const cfg = loadExistingSetupConfig();
  const tunnelId = cfg.DEVTUNNEL_ID;
  if (!tunnelId) return;

  // On Windows, devtunnel.exe may not resolve via spawn() without a shell.
  // Use cmd /c to let Windows handle PATH resolution.
  const isWin = process.platform === "win32";
  const devtunnel = resolveDevtunnel();

  const devtunnelRun = (args: string[], opts?: { stdio?: "pipe" | "inherit"; timeoutMs?: number }) =>
    isWin
      ? runCommand("cmd", ["/c", devtunnel, ...args], {
          stdio: opts?.stdio ?? "pipe",
          allowFailure: true,
          timeoutMs: opts?.timeoutMs ?? 10_000,
        })
      : runCommand(devtunnel, args, {
          stdio: opts?.stdio ?? "pipe",
          allowFailure: true,
          timeoutMs: opts?.timeoutMs ?? 10_000,
        });

  const result = await devtunnelRun(["token", tunnelId, "--scope", "host"]);

  if (result.code !== 0) {
    console.log("Tunnel auth expired. Logging in...");
    const login = await devtunnelRun(["user", "login"], {
      stdio: "inherit",
      timeoutMs: 60_000,
    });
    if (login.code !== 0) {
      throw new Error(
        "devtunnel user login failed. Cannot start without tunnel auth.",
      );
    }
    // Verify token works after login
    const retry = await devtunnelRun(["token", tunnelId, "--scope", "host"]);
    if (retry.code !== 0) {
      throw new Error(
        "Tunnel auth still invalid after login. Check tunnel ownership.",
      );
    }
    console.log("Tunnel auth OK.");
  }
}

async function probe(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    await res.arrayBuffer(); // drain body to avoid dangling handles
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function getTunnelUrl(tunnelId: string): Promise<string | undefined> {
  const devtunnel = resolveDevtunnel();
  const isWin = process.platform === "win32";
  const result = isWin
    ? await runCommand("cmd", ["/c", devtunnel, "show", tunnelId], {
        stdio: "pipe",
        allowFailure: true,
        timeoutMs: 10_000,
      })
    : await runCommand(devtunnel, ["show", tunnelId], {
        stdio: "pipe",
        allowFailure: true,
        timeoutMs: 10_000,
      });
  if (result.code !== 0) return undefined;
  const match = result.stdout.match(/(https:\/\/\S+devtunnels\.ms)\S*/);
  return match?.[1];
}

export async function installCommand(): Promise<void> {
  const platform = detectPlatform();
  await runBuild();
  await preflightCheck();

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

export async function uninstallCommand(): Promise<void> {
  const platform = detectPlatform();
  await uninstallService(platform);
  console.log(
    "Uninstalled service/task. Run 'teams-bot uninstall-skill' to remove /handoff skill.",
  );
}

export async function restartCommand(): Promise<void> {
  const platform = detectPlatform();
  await stopService(platform);
  await preflightCheck();
  await runBuild();
  await startService(platform);
  await pollAndShowLogs(platform);
}

/** Poll healthz and show startup log output. Shared by start and restart. */
async function pollAndShowLogs(platform: Platform): Promise<void> {
  console.log("Starting...");
  const { getLogPaths } = await import("./service.js");
  const logPaths = getLogPaths(platform);
  let ok = false;
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    ok = await probe("http://127.0.0.1:3978/healthz", 2000);
    if (ok) break;
  }

  // Show log output (success or failure)
  const logLines: string[] = [];
  for (const logPath of logPaths) {
    try {
      const content = fs.readFileSync(logPath, "utf8").trim();
      if (content) {
        logLines.push(...content.split(/\r?\n/));
      }
    } catch {
      /* no log file */
    }
  }

  if (ok) {
    // Show key lines from startup log (tunnel URL, etc.)
    const interesting = logLines.filter(
      (l) =>
        l.includes("listening on port") ||
        l.includes("Ready to accept") ||
        l.includes("Connect via browser") ||
        l.includes("Bot PID") ||
        l.includes("ERROR"),
    );
    if (interesting.length > 0) {
      for (const line of interesting) console.log(`  ${line}`);
    }
    console.log("Bot is running.");
  } else {
    console.error("Bot failed to start.\n");
    const tail = logLines.slice(-15);
    if (tail.length > 0) {
      for (const line of tail) console.error(`  ${line}`);
    } else {
      console.error("  (no log output — check bash/node installation)");
    }
  }
}

export async function startCommand(): Promise<void> {
  const platform = detectPlatform();

  // Check if already running
  if (await probe("http://127.0.0.1:3978/healthz", 2000)) {
    console.log("Bot is already running.");
    return;
  }

  await preflightCheck();
  await startService(platform);
  await pollAndShowLogs(platform);
}

export async function stopCommand(): Promise<void> {
  const platform = detectPlatform();
  await stopService(platform);
  // Windows stopService prints its own status messages; mac/linux need explicit confirmation
  if (platform !== "win32") {
    console.log("Stopped.");
  }
}

export async function statusCommand(): Promise<void> {
  const platform = detectPlatform();
  await showStatus(platform);
}

export async function healthCommand(): Promise<void> {
  const platform = detectPlatform();
  await showStatus(platform);

  // Bot process check
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  let data: {
    uptimeSec?: number;
    session?: { active?: boolean; hasQuery?: boolean };
  };
  try {
    const res = await fetch("http://127.0.0.1:3978/healthz", {
      signal: controller.signal,
    });
    if (!res.ok) {
      await res.arrayBuffer(); // drain body to avoid dangling handles
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
  let tunnelUrl: string | undefined;
  try {
    tunnelUrl = await getTunnelUrl(cfg.DEVTUNNEL_ID);
  } catch {
    console.log(
      "Tunnel: FAIL (devtunnel CLI not installed — run: teams-bot setup tunnel)",
    );
    return;
  }
  if (!tunnelUrl) {
    console.log("Tunnel: FAIL (could not resolve tunnel URL)");
    return;
  }
  const tunnelOk = await probe(`${tunnelUrl}/healthz`, 5000);
  console.log(
    tunnelOk ? "Tunnel: OK" : "Tunnel: FAIL (bot ok but tunnel unreachable)",
  );
}

export async function logsCommand(): Promise<void> {
  const platform = detectPlatform();
  await tailLogs(platform);
}
