import fs from "fs";
import os from "os";
import path from "path";
import { randomBytes, randomUUID } from "crypto";
import { CANONICAL_ENV_PATH, HANDOFF_TOKEN_PATH } from "../paths.js";
import { projectDir, resolveDevtunnel } from "./constants.js";
import {
  prompt,
  runCommand,
} from "./utils.js";
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

export function maskPassword(pw: string): string {
  if (pw.length <= 4) return "****";
  return pw.slice(0, 2) + "*".repeat(pw.length - 4) + pw.slice(-2);
}

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
          if (key in result) continue; // first found wins
          const value = match[2].trim();
          if (value) (result as Record<string, string>)[key] = value;
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Fall back to process.env for any missing keys
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

export async function setupCommand(): Promise<void> {
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

  console.log("\nTunnel:");
  let tunnelId =
    (await prompt(
      `  Dev Tunnel ID${existing.DEVTUNNEL_ID ? ` [${existing.DEVTUNNEL_ID}]` : ""}: `,
    )) ||
    existing.DEVTUNNEL_ID ||
    "";

  if (!tunnelId) {
    // Check if devtunnel CLI is available, install if not
    let hasCli = await runCommand(resolveDevtunnel(), ["--version"], {
      stdio: "pipe",
      allowFailure: true,
    });
    if (hasCli.code !== 0) {
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
        hasCli = await runCommand(resolveDevtunnel(), ["--version"], {
          stdio: "pipe",
          allowFailure: true,
        });
      }
      if (hasCli.code !== 0) {
        console.log(
          "  Auto-install failed. Install manually: https://aka.ms/devtunnels",
        );
      }
    }
    if (hasCli.code === 0) {
      const create = await prompt("  No tunnel configured. Create one? (Y/n): ");
      if (create === "" || create.toLowerCase() === "y") {
        const name =
          (await prompt("  Tunnel name [teams-bot]: ")) || "teams-bot";

        // Ensure logged in
        const tokenCheck = await runCommand(
          resolveDevtunnel(),
          ["user", "show"],
          { stdio: "pipe", allowFailure: true },
        );
        if (tokenCheck.code !== 0) {
          console.log("  Logging in to devtunnel...");
          const login = await runCommand(resolveDevtunnel(), ["user", "login"], {
            stdio: "inherit",
            allowFailure: true,
          });
          if (login.code !== 0) {
            console.error("  devtunnel login failed. Skipping tunnel setup.");
          }
        }

        // Create tunnel + port
        const createResult = await runCommand(
          resolveDevtunnel(),
          ["create", "--id", name, "--allow-anonymous"],
          { stdio: "pipe", allowFailure: true },
        );
        if (createResult.code === 0) {
          const portResult = await runCommand(
            resolveDevtunnel(),
            ["port", "create", name, "-p", port],
            { stdio: "pipe", allowFailure: true },
          );
          if (portResult.code === 0) {
            tunnelId = name;
            console.log(`  ✓ Created tunnel "${name}" on port ${port}`);
            console.log(
              `\n  ⚠ Set the messaging endpoint in Azure Portal:`,
            );
            console.log(
              `    https://${name}-${port}.devtunnels.ms/api/messages`,
            );
            console.log(
              `\n    Open: https://portal.azure.com/#view/HubsExtension/BrowseResource/resourceType/Microsoft.BotService%2FbotServices`,
            );
            console.log(
              `    → Your Bot → Settings → Configuration → Messaging endpoint`,
            );
          } else {
            console.error(
              `  Failed to create port: ${portResult.stderr.trim()}`,
            );
          }
        } else {
          console.error(
            `  Failed to create tunnel: ${createResult.stderr.trim()}`,
          );
        }
      }
    }
  }

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
  console.log("  1. Set messaging endpoint in Azure Portal (see setup guide)");
  console.log("  2. Sideload teams-claude-bot.zip to Teams");
  console.log("     (Teams → Apps → Manage your apps → Upload a custom app)");
  console.log("  3. teams-bot install        Register as background service + start");
  console.log("  4. teams-bot health         Verify everything is working");
}
