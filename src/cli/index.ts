#!/usr/bin/env node

import { Command } from "commander";
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

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
