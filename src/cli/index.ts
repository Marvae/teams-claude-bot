#!/usr/bin/env node

import { Command } from "commander";
import fs from "fs";
import path from "path";
import { setupCommand, packageManifest } from "./setup.js";
import {
  installCommand,
  uninstallCommand,
  restartCommand,
  startCommand,
  stopCommand,
  statusCommand,
  healthCommand,
  logsCommand,
} from "./commands.js";
import { installSkill, uninstallSkill } from "./skill.js";

declare const PKG_VERSION: string;

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("teams-bot")
    .description("Cross-platform service manager for teams-claude-bot")
    .version(PKG_VERSION);

  program
    .command("setup")
    .description("Configure bot (interactive or automated)")
    .addHelpText(
      "after",
      `
Modes:
  teams-bot setup           Interactive setup (manual steps)
  teams-bot setup --auto    Automated setup via az CLI (recommended)

Steps (interactive mode):
  azure     Azure Bot app registration (App ID, Client Secret, Tenant ID)
  bot       Bot settings (Work Directory, Allowed Users)
  tunnel    Dev Tunnel configuration (creates or reuses a devtunnel)
  skill     Install /handoff skill for Claude Code

Examples:
  teams-bot setup                     Interactive setup
  teams-bot setup --auto                One-command setup (a few browser sign-ins)
  teams-bot setup --auto --work-dir ~/projects  Specify work directory
  teams-bot setup azure                 Only configure Azure Bot credentials
`,
    )
    .argument("[step]", "run a single step: azure | bot | tunnel | skill")
    .option("--auto", "one-command setup: creates bot, tunnel, sideloads (a few browser sign-ins)")
    .option("--work-dir <path>", "work directory for Claude Code")
    .action(
      async (
        step: string | undefined,
        opts: { auto?: boolean; workDir?: string },
      ) => {
        await setupCommand(step, opts);
      },
    );

  program
    .command("package")
    .description("Generate teams-claude-bot.zip for Teams upload")
    .action(async () => {
      await packageManifest();
    });

  program
    .command("sideload")
    .description("Sideload app to Teams via MOS3 API")
    .action(async () => {
      const { sideloadToTeams } = await import("./setup-auto.js");
      const zipPath = path.resolve(process.cwd(), "teams-claude-bot.zip");
      if (!fs.existsSync(zipPath)) {
        console.log("  teams-claude-bot.zip not found. Run: teams-bot package");
        process.exitCode = 1;
        return;
      }
      const ok = await sideloadToTeams(zipPath);
      if (!ok) process.exitCode = 1;
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

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
