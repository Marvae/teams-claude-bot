import { detectPlatform, resolveDevtunnel } from "./constants.js";
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

  const result = await runCommand(resolveDevtunnel(), ["token", tunnelId, "--scope", "host"], {
    stdio: "pipe",
    allowFailure: true,
  });

  if (result.code !== 0) {
    console.log("Tunnel auth expired. Logging in...");
    const login = await runCommand(resolveDevtunnel(), ["user", "login"], {
      stdio: "inherit",
      allowFailure: true,
    });
    if (login.code !== 0) {
      throw new Error("devtunnel user login failed. Cannot start without tunnel auth.");
    }
    // Verify token works after login
    const retry = await runCommand(resolveDevtunnel(), ["token", tunnelId, "--scope", "host"], {
      stdio: "pipe",
      allowFailure: true,
    });
    if (retry.code !== 0) {
      throw new Error("Tunnel auth still invalid after login. Check tunnel ownership.");
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
  const result = await runCommand(resolveDevtunnel(), ["show", tunnelId], {
    stdio: "pipe",
    allowFailure: true,
    timeoutMs: 10000,
  });
  if (result.code !== 0) return undefined;
  const match = result.stdout.match(/(https:\/\/\S+devtunnels\.ms)\S*/);
  return match?.[1];
}

export async function installCommand(): Promise<void> {
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
  console.log("Restarted.");
}

export async function startCommand(): Promise<void> {
  const platform = detectPlatform();
  await preflightCheck();
  await startService(platform);
  console.log("Started.");
}

export async function stopCommand(): Promise<void> {
  const platform = detectPlatform();
  await stopService(platform);
  console.log("Stopped.");
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
  let data: { uptimeSec?: number; session?: { active?: boolean; hasQuery?: boolean } };
  try {
    const res = await fetch("http://127.0.0.1:3978/healthz", { signal: controller.signal });
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
  const tunnelUrl = await getTunnelUrl(cfg.DEVTUNNEL_ID);
  if (!tunnelUrl) {
    console.log("Tunnel: FAIL (could not resolve tunnel URL)");
    return;
  }
  const tunnelOk = await probe(`${tunnelUrl}/healthz`, 5000);
  console.log(tunnelOk ? "Tunnel: OK" : "Tunnel: FAIL (bot ok but tunnel unreachable)");
}

export async function logsCommand(): Promise<void> {
  const platform = detectPlatform();
  await tailLogs(platform);
}
