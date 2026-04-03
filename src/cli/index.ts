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
import { testCommand } from "./test.js";

declare const PKG_VERSION: string;

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("teams-bot")
    .description("Cross-platform service manager for teams-claude-bot")
    .version(PKG_VERSION);

  program
    .command("setup")
    .description("Interactive config setup (run all steps, or pick one)")
    .addHelpText(
      "after",
      `
Steps:
  azure     Azure Bot app registration (App ID, Client Secret, Tenant ID)
  bot       Bot settings (Work Directory, Allowed Users)
  tunnel    Dev Tunnel configuration (creates or reuses a devtunnel)
  skill     Install /handoff skill for Claude Code

Examples:
  teams-bot setup           Run all steps interactively
  teams-bot setup azure     Only configure Azure Bot credentials
  teams-bot setup tunnel    Only configure Dev Tunnel
`,
    )
    .argument("[step]", "run a single step: azure | bot | tunnel | skill")
    .action(async (step?: string) => {
      await setupCommand(step);
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

  program
    .command("test")
    .description(
      "Send messages to the bot via DevTools (no Teams/tunnel needed)",
    )
    .argument("[message]", "message to send (omit for interactive REPL)")
    .option("--card <action>", "simulate Adaptive Card action")
    .option("-d, --diagnose", "run connectivity diagnostics")
    .addHelpText(
      "after",
      `
Examples:
  teams-bot test                           Interactive REPL
  teams-bot test "What is 2+2?"            One-shot message
  teams-bot test --card prompt_response    Simulate card click
  teams-bot test --diagnose                Check bot, DevTools, tunnel
`,
    )
    .action(
      async (message?: string, options?: { card?: string; diagnose?: boolean }) => {
        await testCommand(message, options);
      },
    );

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
