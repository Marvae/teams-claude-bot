import fs from "fs";
import os from "os";
import path from "path";
import { randomBytes, randomUUID } from "crypto";
import { CANONICAL_ENV_PATH, HANDOFF_TOKEN_PATH } from "../paths.js";
import { projectDir, resolveDevtunnel, resetDevtunnelCache } from "./constants.js";
import { prompt, normalizeYesNo, runCommand } from "./utils.js";
import { maybeInstallSkillPrompt } from "./skill.js";

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

const VALID_STEPS = ["azure", "bot", "tunnel", "skill"] as const;
type SetupStep = (typeof VALID_STEPS)[number];

const STEP_LABELS: Record<SetupStep, string> = {
  azure: "Azure Bot Credentials",
  bot: "Bot Settings",
  tunnel: "Dev Tunnel",
  skill: "/handoff Skill",
};

const LINE = "─".repeat(50);

// ─── Helpers ───

export function maskPassword(pw: string): string {
  if (pw.length <= 4) return "****";
  return pw.slice(0, 2) + "*".repeat(pw.length - 4) + pw.slice(-2);
}

let _singleStep = false;

function stepHeader(step: SetupStep): void {
  console.log(`\n${LINE}`);
  if (_singleStep) {
    console.log(`  ${STEP_LABELS[step]}\n`);
  } else {
    const idx = VALID_STEPS.indexOf(step) + 1;
    console.log(`  Step ${idx}/${VALID_STEPS.length} — ${STEP_LABELS[step]}\n`);
  }
}

function printSummary(config: Partial<SetupConfig>): void {
  console.log(`\n${LINE}`);
  console.log("  Configuration Summary");
  console.log(LINE);
  if (config.MICROSOFT_APP_ID)
    console.log(`  App ID:         ${config.MICROSOFT_APP_ID}`);
  if (config.MICROSOFT_APP_PASSWORD)
    console.log(
      `  Client Secret:  ${maskPassword(config.MICROSOFT_APP_PASSWORD)}`,
    );
  if (config.MICROSOFT_APP_TENANT_ID)
    console.log(`  Tenant ID:      ${config.MICROSOFT_APP_TENANT_ID}`);
  if (config.CLAUDE_WORK_DIR)
    console.log(`  Work Directory: ${config.CLAUDE_WORK_DIR}`);
  if (config.PORT) console.log(`  Port:           ${config.PORT}`);
  if (config.ALLOWED_USERS)
    console.log(`  Allowed Users:  ${config.ALLOWED_USERS}`);
  else console.log(`  Allowed Users:  (everyone)`);
  if (config.DEVTUNNEL_ID) {
    console.log(`  Dev Tunnel:     ${config.DEVTUNNEL_ID}`);
  }
  console.log("");
}

// ─── Config persistence ───

export function loadExistingSetupConfig(): Partial<SetupConfig> {
  const result: Partial<SetupConfig> = {};
  const paths = [CANONICAL_ENV_PATH, path.join(projectDir, ".env")];
  for (const envPath of paths) {
    try {
      const content = fs.readFileSync(envPath, "utf8");
      for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^([A-Z_]+)=(.*)$/);
        if (match) {
          const key = match[1] as keyof SetupConfig;
          if (key in result) continue;
          const value = match[2].trim().replace(/^['"]|['"]$/g, "");
          if (value) (result as Record<string, string>)[key] = value;
        }
      }
    } catch {
      /* ignore */
    }
  }

  const envKeys: Array<keyof SetupConfig> = [
    "MICROSOFT_APP_ID",
    "MICROSOFT_APP_PASSWORD",
    "MICROSOFT_APP_TENANT_ID",
    "CLAUDE_WORK_DIR",
    "PORT",
    "ALLOWED_USERS",
    "DEVTUNNEL_ID",
    "TEAMS_APP_ID",
  ];
  for (const key of envKeys) {
    if (!(key in result) && process.env[key]) {
      (result as Record<string, string>)[key] = process.env[key]!;
    }
  }
  return result;
}

function saveConfig(config: Partial<SetupConfig>): void {
  const merged = { ...loadExistingSetupConfig(), ...config };

  // Quote values with single quotes so bash doesn't interpret backslashes (Windows paths)
  const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  const lines: string[] = [];
  if (merged.MICROSOFT_APP_ID)
    lines.push(`MICROSOFT_APP_ID=${q(merged.MICROSOFT_APP_ID)}`);
  if (merged.MICROSOFT_APP_PASSWORD)
    lines.push(`MICROSOFT_APP_PASSWORD=${q(merged.MICROSOFT_APP_PASSWORD)}`);
  if (merged.MICROSOFT_APP_TENANT_ID)
    lines.push(`MICROSOFT_APP_TENANT_ID=${q(merged.MICROSOFT_APP_TENANT_ID)}`);
  if (merged.CLAUDE_WORK_DIR)
    lines.push(`CLAUDE_WORK_DIR=${q(merged.CLAUDE_WORK_DIR)}`);
  if (merged.PORT) lines.push(`PORT=${q(merged.PORT)}`);
  if (merged.ALLOWED_USERS)
    lines.push(`ALLOWED_USERS=${q(merged.ALLOWED_USERS)}`);
  if (merged.DEVTUNNEL_ID) lines.push(`DEVTUNNEL_ID=${q(merged.DEVTUNNEL_ID)}`);
  if (merged.TEAMS_APP_ID) lines.push(`TEAMS_APP_ID=${q(merged.TEAMS_APP_ID)}`);

  fs.mkdirSync(path.dirname(CANONICAL_ENV_PATH), { recursive: true });
  fs.writeFileSync(CANONICAL_ENV_PATH, lines.join("\n") + "\n", {
    mode: 0o600,
  });
}

export function generateHandoffToken(): void {
  try {
    const existing = fs.readFileSync(HANDOFF_TOKEN_PATH, "utf8").trim();
    if (existing) return;
  } catch {
    /* doesn't exist yet */
  }

  const token = randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(HANDOFF_TOKEN_PATH), { recursive: true });
  fs.writeFileSync(HANDOFF_TOKEN_PATH, token, { mode: 0o600 });
}

export async function packageManifest(
  appId?: string,
  teamsAppId?: string,
): Promise<void> {
  const script = path.join(projectDir, "scripts", "package-manifest.mjs");
  const args = [script];
  if (appId) args.push(appId);
  if (teamsAppId) args.push(teamsAppId);
  await runCommand(process.execPath, args);
}

/** Returns true if the user wants to skip this step. */
async function offerSkip(
  step: SetupStep,
  existing: Partial<SetupConfig>,
): Promise<boolean> {
  if (!isStepConfigured(step, existing)) return false;
  const answer = await prompt(
    "  Already configured. Enter to skip, 'e' to edit: ",
  );
  return answer.toLowerCase() !== "e";
}

// ─── Step: Azure ───

async function stepAzure(
  existing: Partial<SetupConfig>,
): Promise<Partial<SetupConfig>> {
  stepHeader("azure");
  console.log("  Find these in Azure Portal → App Registrations → your app.\n");
  if (await offerSkip("azure", existing)) return {};

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
    console.error("\n  All three fields are required.");
    process.exit(1);
  }

  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(appId)) {
    console.error(
      "\n  App ID must be a UUID (e.g. 12345678-abcd-1234-abcd-1234567890ab).",
    );
    process.exit(1);
  }

  console.log("\n  ✓ Azure credentials configured");
  return {
    MICROSOFT_APP_ID: appId,
    MICROSOFT_APP_PASSWORD: appPassword,
    MICROSOFT_APP_TENANT_ID: tenantId,
  };
}

// ─── Step: Bot ───

async function stepBot(
  existing: Partial<SetupConfig>,
): Promise<Partial<SetupConfig>> {
  stepHeader("bot");
  console.log(
    "  Work Directory: the folder Claude Code operates in (reads/edits files).",
  );
  console.log(
    "  Allowed Users: restrict who can message the bot (blank = everyone).\n",
  );
  if (await offerSkip("bot", existing)) return {};

  const defaultDir = existing.CLAUDE_WORK_DIR || os.homedir();
  let workDir = (await prompt(`  Work Directory [${defaultDir}]: `)) || defaultDir;
  if (workDir === "~") workDir = os.homedir();
  else if (workDir.startsWith("~/") || workDir.startsWith("~\\"))
    workDir = path.resolve(os.homedir(), workDir.slice(2));
  else workDir = path.resolve(workDir);

  const port = "3978";

  const allowedUsers =
    (await prompt(
      `  Allowed Users (comma-separated)${existing.ALLOWED_USERS ? ` [${existing.ALLOWED_USERS}]` : ""}: `,
    )) ||
    existing.ALLOWED_USERS ||
    "";

  console.log("\n  ✓ Bot settings configured");
  return { CLAUDE_WORK_DIR: workDir, PORT: port, ALLOWED_USERS: allowedUsers };
}

// ─── Step: Tunnel ───

export async function ensureDevtunnelCli(): Promise<boolean> {
  let hasCli: { code: number };
  try {
    hasCli = await runCommand(resolveDevtunnel(), ["--version"], {
      stdio: "pipe",
      allowFailure: true,
    });
  } catch {
    hasCli = { code: 1 };
  }
  if (hasCli.code === 0) return true;

  console.log("  devtunnel CLI not found. Installing...");
  const platform = os.platform();
  let installResult: { code: number };
  if (platform === "darwin") {
    installResult = await runCommand("brew", ["install", "devtunnel"], {
      stdio: "inherit",
      allowFailure: true,
    });
  } else if (platform === "win32") {
    installResult = await runCommand(
      "winget",
      ["install", "Microsoft.devtunnel", "--accept-source-agreements"],
      { stdio: "inherit", allowFailure: true },
    );
  } else {
    installResult = await runCommand(
      "bash",
      ["-c", "curl -sL https://aka.ms/DevTunnelCliInstall | bash"],
      { stdio: "inherit", allowFailure: true },
    );
  }
  if (installResult.code === 0) {
    resetDevtunnelCache();
    hasCli = await runCommand(resolveDevtunnel(), ["--version"], {
      stdio: "pipe",
      allowFailure: true,
    });
  }
  if (hasCli.code !== 0) {
    console.log(
      "  Auto-install failed. Install manually: https://aka.ms/devtunnels",
    );
    return false;
  }
  console.log("  ✓ devtunnel CLI installed");
  return true;
}

export async function ensureDevtunnelLogin(): Promise<boolean> {
  const check = await runCommand(resolveDevtunnel(), ["user", "show"], {
    stdio: "pipe",
    allowFailure: true,
  });
  if (check.code === 0) return true;

  console.log("  Logging in to devtunnel...");
  const login = await runCommand(resolveDevtunnel(), ["user", "login"], {
    stdio: "inherit",
    allowFailure: true,
  });
  return login.code === 0;
}

async function stepTunnel(
  existing: Partial<SetupConfig>,
  port?: string,
): Promise<Partial<SetupConfig>> {
  stepHeader("tunnel");
  console.log("  A Dev Tunnel exposes your local bot so Teams can reach it.\n");

  const resolvedPort = port || existing.PORT || "3978";

  // Always ensure devtunnel CLI is installed and authenticated (needed at runtime)
  const hasCli = await ensureDevtunnelCli();
  if (!hasCli) return { DEVTUNNEL_ID: existing.DEVTUNNEL_ID || "" };

  const loggedIn = await ensureDevtunnelLogin();
  if (!loggedIn) {
    console.error(
      "  Login failed. Run 'devtunnel user login' manually, then re-run setup.",
    );
    return { DEVTUNNEL_ID: existing.DEVTUNNEL_ID || "" };
  }

  // Already configured — verify ownership before offering to keep
  if (existing.DEVTUNNEL_ID) {
    const verify = await runCommand(
      resolveDevtunnel(),
      ["token", existing.DEVTUNNEL_ID, "--scope", "host"],
      { stdio: "pipe", allowFailure: true },
    );
    if (verify.code === 0) {
      const showRes = await runCommand(
        resolveDevtunnel(),
        ["show", existing.DEVTUNNEL_ID],
        { stdio: "pipe", allowFailure: true },
      );
      const existingUrl =
        showRes.stdout.match(/(https:\/\/\S+\.devtunnels\.ms)\S*/)?.[1] ?? "";
      console.log(
        `  Current: ${existing.DEVTUNNEL_ID}${existingUrl ? ` (${existingUrl})` : ""}`,
      );
      const keep = await prompt("  Keep this tunnel? (Y/n): ");
      if (normalizeYesNo(keep, true)) {
        console.log("\n  ✓ Tunnel verified and unchanged");
        return { DEVTUNNEL_ID: existing.DEVTUNNEL_ID };
      }
    } else {
      console.log(
        `  Tunnel "${existing.DEVTUNNEL_ID}" is not accessible from this machine.`,
      );
      console.log("  Creating a new tunnel instead.\n");
    }
  }

  // Create tunnel with auto-generated name
  console.log("  Creating tunnel...");
  const create = await runCommand(
    resolveDevtunnel(),
    ["create", "--allow-anonymous"],
    { stdio: "pipe", allowFailure: true },
  );
  if (create.code !== 0) {
    console.error(
      `  Failed to create tunnel: ${(create.stderr || create.stdout).trim()}`,
    );
    return { DEVTUNNEL_ID: "" };
  }

  // Parse tunnel ID from "Tunnel ID : xxx" output
  const idMatch = create.stdout.match(/Tunnel ID\s*:\s*(\S+)/i);
  const name = idMatch?.[1] ?? "";
  if (!name) {
    console.error("  Could not determine tunnel ID from output:");
    console.error(`  ${create.stdout.trim().split("\n")[0]}`);
    return { DEVTUNNEL_ID: "" };
  }

  // Add port to tunnel
  const portResult = await runCommand(
    resolveDevtunnel(),
    ["port", "create", name, "-p", resolvedPort],
    { stdio: "pipe", allowFailure: true },
  );
  if (
    portResult.code !== 0 &&
    !(portResult.stderr || "").includes("already exists")
  ) {
    console.error(
      `  Failed to create port: ${(portResult.stderr || portResult.stdout).trim()}`,
    );
    return { DEVTUNNEL_ID: "" };
  }

  // Get the real URL from devtunnel show
  const showResult = await runCommand(resolveDevtunnel(), ["show", name], {
    stdio: "pipe",
    allowFailure: true,
  });
  const urlMatch = showResult.stdout.match(
    /(https:\/\/\S+\.devtunnels\.ms)\S*/,
  );
  const url = urlMatch?.[1];

  console.log(`\n  ✓ Tunnel "${name}" ready`);
  if (url) {
    console.log(`    URL: ${url}`);
    console.log(`\n  Set the messaging endpoint in Azure Portal:`);
    console.log(`    ${url}/api/messages`);
    console.log(
      `    (Azure Portal → Bot → Settings → Configuration → Messaging endpoint)`,
    );
  } else {
    console.log(`\n  Run 'devtunnel show ${name}' to find your tunnel URL.`);
    console.log(
      "  Set it as messaging endpoint in Azure Portal (append /api/messages).",
    );
  }

  return { DEVTUNNEL_ID: name };
}

// ─── Step: Skill ───

async function stepSkill(): Promise<void> {
  stepHeader("skill");
  console.log(
    "  /handoff lets you transfer a Claude Code terminal session to Teams,",
  );
  console.log("  so you can continue the conversation from your phone.\n");
  await maybeInstallSkillPrompt();
}

// ─── Main entry point ───

export async function setupCommand(
  step?: string,
  options?: { auto?: boolean; workDir?: string },
): Promise<void> {
  if (options?.auto) {
    try {
      const { autoSetupCommand } = await import("./setup-auto.js");
      await autoSetupCommand(options.workDir);
    } catch (e: unknown) {
      console.error(`\n  ✗ ${(e as Error).message}\n`);
      console.error("  Progress has been saved. Run 'teams-bot setup --auto' again to resume.\n");
      process.exitCode = 1;
    }
    return;
  }

  if (step && !VALID_STEPS.includes(step as SetupStep)) {
    console.error(`Unknown step: "${step}"`);
    console.error(`Valid steps: ${VALID_STEPS.join(", ")}`);
    process.exit(1);
  }

  const existing = loadExistingSetupConfig();
  const singleStep = step as SetupStep | undefined;
  _singleStep = !!singleStep;
  const collected: Partial<SetupConfig> = {};

  // Save on Ctrl+C so completed steps are not lost
  const onExit = (): void => {
    if (Object.keys(collected).length > 0) {
      if (!collected.TEAMS_APP_ID && !existing.TEAMS_APP_ID) {
        collected.TEAMS_APP_ID = randomUUID();
      }
      saveConfig(collected);
      console.log(`\n\nProgress saved to ${CANONICAL_ENV_PATH}`);
    }
    process.exit(0);
  };
  process.on("SIGINT", onExit);

  // Header
  if (!singleStep) {
    console.log("\n  Teams Claude Bot — Setup\n");
    console.log("  Steps:");
    for (const s of VALID_STEPS) {
      const idx = VALID_STEPS.indexOf(s) + 1;
      const check = isStepConfigured(s, existing) ? "✓" : " ";
      const suffix = s === "skill" ? " (optional)" : "";
      console.log(`    ${check} ${idx}. ${STEP_LABELS[s]}${suffix}`);
    }
    if (Object.keys(existing).length > 0) {
      console.log(
        "\n  Existing config detected — press Enter to keep [current values].",
      );
    }
    console.log(
      "  Press Ctrl+C to quit. Completed steps are saved automatically.",
    );
  }

  // Run steps
  if (!singleStep || singleStep === "azure") {
    Object.assign(collected, await stepAzure(existing));
    saveConfig(collected); // save after each step
  }

  if (!singleStep || singleStep === "bot") {
    Object.assign(collected, await stepBot(existing));
    saveConfig(collected);
  }

  if (!singleStep || singleStep === "tunnel") {
    Object.assign(collected, await stepTunnel(existing, collected.PORT));
    saveConfig(collected);
  }

  // Finalize
  if (!singleStep && Object.keys(collected).length > 0) {
    if (!existing.TEAMS_APP_ID && !collected.TEAMS_APP_ID) {
      collected.TEAMS_APP_ID = randomUUID();
      saveConfig(collected);
    }
    generateHandoffToken();
    const merged = { ...existing, ...collected };
    await packageManifest(merged.MICROSOFT_APP_ID, merged.TEAMS_APP_ID);
  }

  if (!singleStep || singleStep === "skill") {
    await stepSkill();
  }

  // Summary
  process.removeListener("SIGINT", onExit);
  const final = { ...existing, ...collected };

  if (!singleStep) {
    printSummary(final);
    console.log(`  Config saved to ${CANONICAL_ENV_PATH}\n`);
    console.log("  Next steps:");
    console.log("    1. Set messaging endpoint in Azure Portal");
    if (final.DEVTUNNEL_ID) {
      console.log(`       Run: devtunnel show ${final.DEVTUNNEL_ID}  (to find the URL)`);
    }
    console.log(`    2. Sideload teams-claude-bot.zip to Teams`);
    console.log(`       File: ${path.resolve("teams-claude-bot.zip")}`);
    console.log(
      "       (Teams → Apps → Manage your apps → Upload a custom app)",
    );
    console.log(
      "    3. teams-bot install        Register as background service + start",
    );
    console.log(
      "    4. teams-bot health         Verify everything is working\n",
    );
  }
}

function isStepConfigured(
  step: SetupStep,
  config: Partial<SetupConfig>,
): boolean {
  switch (step) {
    case "azure":
      return !!(
        config.MICROSOFT_APP_ID &&
        config.MICROSOFT_APP_PASSWORD &&
        config.MICROSOFT_APP_TENANT_ID
      );
    case "bot":
      return !!config.CLAUDE_WORK_DIR;
    case "tunnel":
      return !!config.DEVTUNNEL_ID;
    case "skill":
      return false; // can't easily detect
  }
}
