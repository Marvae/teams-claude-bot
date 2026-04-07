/**
 * Automated setup — creates Azure Bot + Dev Tunnel + manifest via CLI tools.
 *
 * Requires: az CLI (logged in), devtunnel CLI.
 * Uses personal Azure account for bot creation, corporate account for MOS3 sideload.
 */

import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { CANONICAL_ENV_PATH } from "../paths.js";
import { resolveDevtunnel } from "./constants.js";
import { runCommand } from "./utils.js";
import { loadExistingSetupConfig, generateHandoffToken, ensureDevtunnelCli, ensureDevtunnelLogin } from "./setup.js";

const TOOLKIT_CLIENT_ID = "7ea7c24c-b1f6-4a20-9d11-9ae12e9e7ac0";
const MOS3_BASE = "https://titles.prod.mos.microsoft.com";

interface AutoSetupState {
  appId?: string;
  botName?: string;
  tenantId?: string;
  clientSecret?: string;
  resourceGroup?: string;
  botCreated?: boolean;
  teamsChannelEnabled?: boolean;
  tunnelId?: string;
  tunnelUrl?: string;
  teamsAppId?: string;
}

// ── State persistence (resume on failure) ───────────────────────────────

const STATE_PATH = path.join(
  os.homedir(),
  ".claude",
  "teams-bot",
  ".setup-state.json",
);

function saveState(state: AutoSetupState): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
}

function loadState(): AutoSetupState {
  // Try state file first (in-progress setup)
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as AutoSetupState;
  } catch { /* no state file */ }

  // Fall back to .env — if setup completed before, reuse existing resources
  const existing = loadExistingSetupConfig();
  if (existing.MICROSOFT_APP_ID) {
    return {
      appId: existing.MICROSOFT_APP_ID,
      clientSecret: existing.MICROSOFT_APP_PASSWORD,
      tenantId: existing.MICROSOFT_APP_TENANT_ID,
      tunnelId: existing.DEVTUNNEL_ID,
      // If we have appId + secret, assume bot was fully created
      botCreated: !!(existing.MICROSOFT_APP_ID && existing.MICROSOFT_APP_PASSWORD),
      teamsChannelEnabled: !!(existing.MICROSOFT_APP_ID && existing.MICROSOFT_APP_PASSWORD),
    };
  }

  return {};
}

function clearState(): void {
  try {
    fs.unlinkSync(STATE_PATH);
  } catch {
    /* ignore */
  }
}

// ── az CLI helpers ───────────────────────────────────────────────────────

function az(cmd: string): string {
  try {
    return execSync(`az ${cmd}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (e: unknown) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`az ${cmd} failed: ${err.stderr || err.message}`, { cause: e });
  }
}

function azJson<T = Record<string, unknown>>(cmd: string): T {
  return JSON.parse(az(`${cmd} --output json`)) as T;
}

// ── Prerequisites ────────────────────────────────────────────────────────

async function ensureAzCli(): Promise<void> {
  console.log("  Checking az CLI...");
  try {
    execSync("az --version", { stdio: "pipe" });
    console.log("  ✓ az CLI found");
    return;
  } catch {
    // Not installed — try to auto-install
  }

  console.log("  Installing az CLI (this may take a minute)...");
  const platform = os.platform();
  try {
    if (platform === "darwin") {
      try {
        execSync("which brew", { stdio: "pipe" });
        execSync("brew install azure-cli", { stdio: "inherit" });
      } catch {
        execSync("curl -sL https://aka.ms/InstallAzureCLIMacOS | bash", {
          stdio: "inherit",
        });
      }
    } else if (platform === "linux") {
      execSync("curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash", {
        stdio: "inherit",
      });
    } else if (platform === "win32") {
      execSync(
        "winget install Microsoft.AzureCLI --accept-source-agreements",
        { stdio: "inherit" },
      );
    }
    // Verify
    execSync("az --version", { stdio: "pipe" });
    console.log("  ✓ az CLI installed");
  } catch {
    throw new Error(
      "Failed to install az CLI. Install manually: https://aka.ms/installazurecli",
    );
  }
}

function ensureLogin(): { tenantId: string; userName: string } {
  console.log("  Checking az CLI login...");
  let account: { tenantId: string; user?: { name: string }; name: string };
  try {
    account = azJson<typeof account>("account show");
  } catch {
    console.log("  Opening browser — sign in with your Azure account (personal Microsoft account recommended)...");
    try {
      // Use pipe to capture output for MFA error detection, but also display it
      const loginOut = execSync("az login", { encoding: "utf-8", stdio: ["inherit", "pipe", "pipe"] });
      if (loginOut) process.stdout.write(loginOut);
    } catch (e: unknown) {
      // stdio: "pipe" captures stderr/stdout in the error object
      const stderr = String((e as { stderr?: string }).stderr ?? "");
      const stdout = String((e as { stdout?: string }).stdout ?? "");
      const output = stderr + stdout;
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);

      // If MFA fails, az CLI prints the tenant ID to use — parse and auto-retry
      // e.g. "please use `az login --tenant TENANT_ID`.\ncb6b84cb-... '默认目录'"
      const tenantMatch = output.match(
        /az login --tenant TENANT_ID[`'"]?\.\s*\n\s*([0-9a-f-]{36})/i,
      );
      if (tenantMatch) {
        const tenant = tenantMatch[1];
        console.log(`\n  ⚠ MFA required by a guest tenant, retrying with --tenant ${tenant}...`);
        try {
          execSync(`az login --tenant ${tenant}`, { stdio: "inherit" });
        } catch {
          console.log("\n  ⚠ Login failed. Please log in manually, then re-run setup:");
          console.log(`    az login --tenant ${tenant}`);
          console.log("    teams-bot setup --auto\n");
          throw new Error("Azure login failed. See instructions above.", { cause: e });
        }
      } else {
        console.log("\n  ⚠ Login failed. Please log in manually, then re-run setup:");
        console.log("    az login");
        console.log("    teams-bot setup --auto\n");
        throw new Error("Azure login failed. Log in manually with 'az login' and re-run.", { cause: e });
      }
    }
    account = azJson<typeof account>("account show");
  }
  console.log(`  ✓ Signed in as ${account.user?.name}`);

  // Check for subscription — needed for az bot create / az group create
  try {
    const subs = azJson<Array<{ id: string }>>("account list");
    if (!subs || subs.length === 0) {
      throw new Error("none");
    }
  } catch {
    console.log("\n  ⚠ No Azure subscription found.");
    console.log("    A free subscription is required to create bot resources.");
    console.log("    Create one at: https://azure.microsoft.com/free/");
    throw new Error(
      "No Azure subscription. Create a free one at https://azure.microsoft.com/free/ and re-run setup.",
    );
  }

  return { tenantId: account.tenantId, userName: account.user?.name ?? "" };
}

// ── Step 1: App Registration ─────────────────────────────────────────────

function createAppRegistration(
  state: AutoSetupState,
  tenantId: string,
): AutoSetupState {
  if (state.appId) {
    console.log(`  ✓ App Registration: ${state.appId}`);
    return state;
  }

  const suffix = Date.now().toString(36);
  const botName = `claude-teams-bot-${suffix}`;
  console.log(`\n  Creating App Registration: ${botName}...`);

  try {
    const app = azJson<{ appId: string }>(
      `ad app create --display-name "${botName}" --sign-in-audience AzureADMultipleOrgs`,
    );
    console.log(`  ✓ App ID: ${app.appId}`);

    // Create service principal — az ad app create does NOT create one automatically
    // (unlike the Azure Portal UI). Without it, token acquisition fails with AADSTS7000229.
    try {
      az(`ad sp create --id ${app.appId}`);
      console.log(`  ✓ Service Principal created`);
    } catch (spErr: unknown) {
      const spMsg = (spErr as Error).message;
      // Ignore "already exists" — idempotent
      if (!spMsg.includes("already exist")) {
        throw new Error("Failed to create Service Principal. Token acquisition will fail (AADSTS7000229).", { cause: spErr });
      }
    }

    return { ...state, appId: app.appId, botName, tenantId };
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg.includes("Forbidden") || msg.includes("Authorization")) {
      throw new Error("Permission denied creating App Registration. Your account may not have Azure AD permissions.", { cause: e });
    }
    throw e;
  }
}

// ── Step 2: Client Secret ────────────────────────────────────────────────

function createSecret(state: AutoSetupState): AutoSetupState {
  if (state.clientSecret) {
    console.log("  ✓ Client secret exists");
    return state;
  }

  console.log("  Creating client secret...");
  const cred = azJson<{ password: string }>(
    `ad app credential reset --id ${state.appId} --years 2`,
  );
  console.log("  ✓ Secret generated");

  return { ...state, clientSecret: cred.password };
}

// ── Step 3: Azure Bot Resource ───────────────────────────────────────────

function createBot(state: AutoSetupState): AutoSetupState {
  if (state.botCreated) {
    console.log("  ✓ Bot resource exists");
    return state;
  }

  const rgName = "rg-claude-teams-bot";

  // Ensure resource group
  try {
    az(`group show --name ${rgName}`);
  } catch {
    console.log(`  Creating resource group: ${rgName}...`);
    try {
      az(`group create --name ${rgName} --location eastus`);
    } catch (e: unknown) {
      const msg = (e as Error).message;
      if (msg.includes("SubscriptionNotFound") || msg.includes("subscription")) {
        throw new Error("No active subscription. Create a free one at https://azure.microsoft.com/free/", { cause: e });
      }
      if (msg.includes("LocationNotAvailableForResourceGroup")) {
        throw new Error(`Region 'eastus' not available for your subscription. Try a different Azure region.`, { cause: e });
      }
      throw e;
    }
  }

  // Create bot — retry with new name on conflict
  let botName = state.botName!;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      console.log(`  Creating bot: ${botName}...`);
      az(
        `bot create --name "${botName}" --resource-group ${rgName}` +
          ` --app-type SingleTenant --appid ${state.appId} --tenant-id ${state.tenantId}` +
          ` --sku F0`,
      );
      console.log("  ✓ Bot created (SingleTenant, F0)");
      return {
        ...state,
        botName,
        botCreated: true,
        resourceGroup: rgName,
      };
    } catch (e: unknown) {
      const msg = (e as Error).message;
      if (msg.includes("not available") || msg.includes("Conflict")) {
        const suffix = Math.random().toString(36).slice(2, 6);
        botName = `${state.botName}-${suffix}`;
        console.log(`  Name taken, retrying: ${botName}...`);
        continue;
      }
      throw e;
    }
  }

  throw new Error("Failed to create bot after 3 attempts (name conflicts)");
}

// ── Step 4: Teams Channel ────────────────────────────────────────────────

function enableTeamsChannel(state: AutoSetupState): AutoSetupState {
  if (state.teamsChannelEnabled) {
    console.log("  ✓ Teams channel enabled");
    return state;
  }

  console.log("  Enabling Teams channel...");
  try {
    az(
      `bot msteams create --name "${state.botName}" --resource-group ${state.resourceGroup}`,
    );
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (!msg.includes("already exists") && !msg.includes("Conflict")) throw e;
  }
  console.log("  ✓ Teams channel enabled");

  return { ...state, teamsChannelEnabled: true };
}

// ── Step 5: Dev Tunnel ───────────────────────────────────────────────────

async function setupTunnel(state: AutoSetupState): Promise<AutoSetupState> {
  if (state.tunnelId) {
    console.log(`  ✓ Dev tunnel: ${state.tunnelId}`);
    updateBotEndpoint(state);
    return state;
  }

  // Ensure devtunnel CLI installed and logged in (reuse setup.ts logic)
  const cliOk = await ensureDevtunnelCli();
  if (!cliOk) {
    throw new Error("Failed to install devtunnel CLI. Install manually: https://aka.ms/devtunnels");
  }
  const loginOk = await ensureDevtunnelLogin();
  if (!loginOk) {
    throw new Error("devtunnel login failed");
  }
  const devtunnel = resolveDevtunnel();

  // Create tunnel
  console.log("  Creating dev tunnel...");
  let create = await runCommand(
    devtunnel,
    ["create", "--allow-anonymous"],
    { stdio: "pipe", allowFailure: true },
  );
  // If auth expired / not logged in, re-login and retry once
  if (create.code !== 0 && /unauthorized|anonymous/i.test(create.stderr + create.stdout)) {
    console.log("  ⚠ devtunnel auth expired, re-logging in...");
    await runCommand(devtunnel, ["user", "login"], { stdio: "inherit", allowFailure: true });
    create = await runCommand(
      devtunnel,
      ["create", "--allow-anonymous"],
      { stdio: "pipe", allowFailure: true },
    );
  }
  if (create.code !== 0) {
    throw new Error(
      `Failed to create tunnel: ${(create.stderr || create.stdout).trim()}`,
    );
  }

  const idMatch = create.stdout.match(/Tunnel ID\s*:\s*(\S+)/i);
  const tunnelId = idMatch?.[1] ?? "";
  if (!tunnelId) {
    throw new Error(`Could not parse tunnel ID from: ${create.stdout.trim()}`);
  }

  // Add port
  const portResult = await runCommand(devtunnel, ["port", "create", tunnelId, "-p", "3978"], {
    stdio: "pipe",
    allowFailure: true,
  });
  if (portResult.code !== 0) {
    const msg = (portResult.stderr || portResult.stdout).trim();
    // "already exists" is fine — means port was added previously
    if (!msg.includes("already exists")) {
      throw new Error(`Failed to add port 3978 to tunnel: ${msg}`);
    }
  }

  // URL is only available when tunnel is being hosted — try but don't construct
  let tunnelUrl = "";
  const showResult = await runCommand(devtunnel, ["show", tunnelId], {
    stdio: "pipe",
    allowFailure: true,
  });
  const urlMatch = showResult.stdout.match(
    /(https:\/\/\S+\.devtunnels\.ms)\S*/,
  );
  if (urlMatch) {
    tunnelUrl = urlMatch[1];
  }

  console.log(`  ✓ Tunnel: ${tunnelId}`);
  if (tunnelUrl) {
    console.log(`    URL: ${tunnelUrl}`);
  } else {
    console.log("  ⚠ Could not determine tunnel URL. Bot endpoint will not be set.");
    console.log("    Run: devtunnel show " + tunnelId);
    console.log("    Then set the endpoint in Azure Portal → Bot → Configuration → Messaging endpoint");
  }

  const newState = { ...state, tunnelId, tunnelUrl };
  updateBotEndpoint(newState);
  return newState;
}

function updateBotEndpoint(state: AutoSetupState): void {
  if (!state.tunnelUrl || !state.botName || !state.resourceGroup) return;
  const endpoint = `${state.tunnelUrl}/api/messages`;
  console.log(`  Updating bot endpoint: ${endpoint}`);
  try {
    az(
      `bot update --name "${state.botName}" --resource-group ${state.resourceGroup}` +
        ` --endpoint "${endpoint}"`,
    );
    console.log("  ✓ Bot endpoint updated");
  } catch (e: unknown) {
    console.log(`  ⚠ Endpoint update failed: ${(e as Error).message}`);
    console.log(`  Set it manually in Azure Portal: ${endpoint}`);
  }
}

// ── Step 6: Generate manifest ────────────────────────────────────────────

async function generateManifest(state: AutoSetupState): Promise<AutoSetupState> {
  console.log("  Generating manifest zip...");

  const teamsAppId = state.teamsAppId || randomUUID();
  const { packageManifest } = await import("./setup.js");
  await packageManifest(state.appId, teamsAppId);

  return { ...state, teamsAppId };
}

// ── Step 7: MOS3 Sideload ────────────────────────────────────────────────

export async function sideloadToTeams(zipPath: string): Promise<boolean> {
  console.log("  Sideloading to Teams via MOS3...");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let msalNode: any;
  try {
    msalNode = await import("@azure/msal-node");
  } catch {
    console.log(
      "  ⚠ @azure/msal-node not available — skipping auto-sideload.",
    );
    console.log("    Sideload manually: Teams → Apps → Manage your apps → Upload a custom app");
    return false;
  }

  const pca = new msalNode.PublicClientApplication({
    auth: {
      clientId: TOOLKIT_CLIENT_ID,
      authority: "https://login.microsoftonline.com/common",
    },
  });

  console.log("  Opening browser — sign in with the Teams account you'll chat with...");
  let token: string;
  try {
    const authResult = await pca.acquireTokenInteractive({
      scopes: [`${MOS3_BASE}/.default`],
      openBrowser: async (url: string) => {
        if (os.platform() === "darwin") execSync(`open "${url}"`);
        else if (os.platform() === "win32") execSync(`powershell -Command "Start-Process '${url}'"`);
        else execSync(`xdg-open "${url}"`);
      },
      successTemplate:
        "<h1>Authenticated!</h1><p>You can close this window.</p>",
      errorTemplate: "<h1>Failed</h1><p>{{error}}</p>",
    });
    token = authResult.accessToken;
  } catch {
    console.log("  ⚠ Teams sign-in failed or was cancelled.");
    console.log("    Sideload manually: Teams → Apps → Manage your apps → Upload a custom app");
    return false;
  }

  const zipBuffer = fs.readFileSync(zipPath);
  const boundary = `----FormBoundary${Date.now()}`;
  const bodyStart = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="app.zip"\r\nContent-Type: application/zip\r\n\r\n`,
  );
  const bodyEnd = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([bodyStart, zipBuffer, bodyEnd]);

  let resp = await fetch(
    `${MOS3_BASE}/builder/v1/users/packages?scope=Personal`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    },
  );

  if ([400, 404, 405].includes(resp.status)) {
    resp = await fetch(`${MOS3_BASE}/dev/v1/users/packages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
  }

  if (!resp.ok) {
    const text = await resp.text();
    console.log(`  ⚠ Sideload failed (${resp.status}): ${text}`);
    console.log("    Sideload manually: Teams → Apps → Manage your apps → Upload a custom app");
    return false;
  }

  console.log("  ✓ App sideloaded to Teams");
  return true;
}

// ── Save config ──────────────────────────────────────────────────────────

function saveEnvConfig(state: AutoSetupState, workDir: string): void {
  // Merge with existing config to preserve fields like ALLOWED_USERS
  const existing = loadExistingSetupConfig();

  const merged: Record<string, string> = {
    ...existing,
    ...(state.appId && { MICROSOFT_APP_ID: state.appId }),
    ...(state.clientSecret && { MICROSOFT_APP_PASSWORD: state.clientSecret }),
    ...(state.tenantId && { MICROSOFT_APP_TENANT_ID: state.tenantId }),
    CLAUDE_WORK_DIR: workDir,
    PORT: "3978",
    ...(state.tunnelId && { DEVTUNNEL_ID: state.tunnelId }),
    ...(state.teamsAppId && { TEAMS_APP_ID: state.teamsAppId }),
  };

  const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  const lines = Object.entries(merged)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${q(v)}`);

  fs.mkdirSync(path.dirname(CANONICAL_ENV_PATH), { recursive: true });
  fs.writeFileSync(CANONICAL_ENV_PATH, lines.join("\n") + "\n", {
    mode: 0o600,
  });
}

// ── Teardown ─────────────────────────────────────────────────────────────

export async function autoTeardown(): Promise<void> {
  console.log("\n  Tearing down auto-setup resources...\n");

  // Read current config to find resource names
  let appId = "";
  let botName = "";
  let resourceGroup = "";
  let tunnelId = "";

  try {
    const content = fs.readFileSync(CANONICAL_ENV_PATH, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^([A-Z_]+)='?([^']*)'?$/);
      if (!match) continue;
      const [, key, value] = match;
      if (key === "MICROSOFT_APP_ID") appId = value;
      if (key === "DEVTUNNEL_ID") tunnelId = value;
    }
  } catch {
    console.log("  No config found.");
    return;
  }

  // Validate appId is a UUID before using in shell commands
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (appId && !uuidRegex.test(appId)) {
    console.log(`  ⚠ Invalid App ID format: "${appId}" — skipping Azure cleanup`);
    appId = "";
  }

  // We need bot name + RG — try to infer from Azure
  if (appId) {
    try {
      // Find bot by app ID
      const bots = az(
        `resource list --resource-type Microsoft.BotService/botServices --query "[?properties.msaAppId=='${appId}'].{name:name, resourceGroup:resourceGroup}" --output json`,
      );
      const parsed = JSON.parse(bots) as Array<{
        name: string;
        resourceGroup: string;
      }>;
      if (parsed.length > 0) {
        botName = parsed[0].name;
        resourceGroup = parsed[0].resourceGroup;
      }
    } catch {
      /* ignore */
    }
  }

  if (tunnelId) {
    try {
      const devtunnel = resolveDevtunnel();
      await runCommand(devtunnel, ["delete", tunnelId, "--yes"], {
        stdio: "pipe",
        allowFailure: true,
      });
      console.log(`  ✓ Tunnel "${tunnelId}" deleted`);
    } catch {
      console.log(`  ⚠ Could not delete tunnel "${tunnelId}"`);
    }
  }

  if (botName && resourceGroup) {
    try {
      az(
        `bot delete --name "${botName}" --resource-group ${resourceGroup} --yes`,
      );
      console.log(`  ✓ Bot "${botName}" deleted`);
    } catch (e: unknown) {
      console.log(`  ⚠ Bot delete: ${(e as Error).message}`);
    }
  }

  if (appId) {
    try {
      az(`ad app delete --id ${appId}`);
      console.log("  ✓ App Registration deleted");
    } catch (e: unknown) {
      console.log(`  ⚠ App delete: ${(e as Error).message}`);
    }
  }

  console.log("\n  ✓ Teardown complete");
}

// ── Main entry ───────────────────────────────────────────────────────────

export async function autoSetupCommand(workDir?: string): Promise<void> {
  console.log("\n  Teams Claude Bot — Automated Setup\n");

  // Load previous state (resume support)
  let state = loadState();
  const resuming = !!(state.appId || state.tunnelId);
  if (resuming) {
    console.log("  Resuming previous setup...");
    if (state.appId) console.log(`    App ID:  ${state.appId}`);
    if (state.tunnelId) console.log(`    Tunnel:  ${state.tunnelId}`);
    console.log("");
  }

  // ── Checking your system ──
  console.log("  Checking your system...");
  await ensureAzCli();
  const { tenantId } = ensureLogin();

  // ── Step 1/4: Set up Azure Bot ──
  console.log("\n  Step 1/4: Set up Azure Bot");
  state = createAppRegistration(state, tenantId);
  saveState(state);

  state = createSecret(state);
  saveState(state);

  state = createBot(state);
  saveState(state);

  state = enableTeamsChannel(state);
  saveState(state);

  // ── Step 2/4: Set up tunnel ──
  console.log("\n  Step 2/4: Set up tunnel");
  state = await setupTunnel(state);
  saveState(state);

  // ── Step 3/4: Configure & start service ──
  console.log("\n  Step 3/4: Configure & start service");
  state = await generateManifest(state);
  saveState(state);

  let resolvedWorkDir = workDir;
  if (!resolvedWorkDir) {
    const { prompt: ask } = await import("./utils.js");
    const defaultDir = os.homedir();
    const answer = await ask(`  Work directory for Claude Code [${defaultDir}]: `);
    resolvedWorkDir = answer || defaultDir;
  }
  // Expand ~ without importing config.ts (which pulls in dotenv/CJS)
  if (resolvedWorkDir === "~") resolvedWorkDir = os.homedir();
  else if (resolvedWorkDir.startsWith("~/") || resolvedWorkDir.startsWith("~\\"))
    resolvedWorkDir = path.resolve(os.homedir(), resolvedWorkDir.slice(2));
  else resolvedWorkDir = path.resolve(resolvedWorkDir);
  if (!fs.existsSync(resolvedWorkDir)) {
    console.log(`  ⚠ Directory does not exist: ${resolvedWorkDir}`);
    console.log("    Claude Code will create it on first use, or create it now manually.");
  }
  saveEnvConfig(state, resolvedWorkDir);
  console.log(`  ✓ Config saved to ${CANONICAL_ENV_PATH}`);
  generateHandoffToken();

  // ── Install service (non-blocking) ──
  console.log("\n  Installing service...");
  let serviceOk = false;
  let skipInstall = false;
  if (process.platform === "win32") {
    try {
      execSync("net session", { stdio: "ignore" });
    } catch {
      skipInstall = true;
      console.log("  ⚠ Not running as Administrator — skipping service registration.");
      console.log("    Run separately: teams-bot install  (as Administrator)");
    }
  }
  if (!skipInstall) {
    try {
      const { installCommand } = await import("./commands.js");
      await installCommand();
      serviceOk = true;
    } catch (e: unknown) {
      console.log(`  ⚠ Service install failed: ${(e as Error).message}`);
      console.log("    Run separately: teams-bot install");
    }
  }

  // ── Sideload (non-blocking) ──
  console.log("\n  Sideloading to Teams...");
  const zipPath = path.resolve(process.cwd(), "teams-claude-bot.zip");
  const sideloaded = await sideloadToTeams(zipPath);

  // ── Done — clear state file ──
  clearState();

  const chatUrl = `https://teams.microsoft.com/l/chat/0/0?users=28:${state.appId}`;
  console.log("\n  ──────────────────────────────────────────────────");
  console.log("  ✓ Setup complete!\n");
  console.log(`    Bot name:      ${state.botName}`);
  console.log(`    App ID:        ${state.appId}`);
  if (state.tunnelId) console.log(`    Tunnel:        ${state.tunnelId}`);
  console.log(`    Work dir:      ${resolvedWorkDir}`);
  console.log(`    Chat:          ${chatUrl}`);

  const nextSteps: string[] = [];
  if (!serviceOk) nextSteps.push("teams-bot install" + (process.platform === "win32" ? "  (as Administrator)" : ""));
  if (!sideloaded) nextSteps.push("teams-bot sideload  (or upload teams-claude-bot.zip manually)");
  if (nextSteps.length > 0) {
    console.log("\n  Remaining steps:");
    nextSteps.forEach((s, i) => console.log(`    ${i + 1}. ${s}`));
    console.log("");
  } else {
    console.log("\n  Send the bot a message to test!\n");
    try {
      if (process.platform === "darwin") execSync(`open "${chatUrl}"`);
      else if (process.platform === "win32") execSync(`powershell -Command "Start-Process '${chatUrl}'"`);
      else execSync(`xdg-open "${chatUrl}"`);
    } catch { /* ignore */ }
  }
}
