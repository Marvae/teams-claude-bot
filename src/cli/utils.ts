import fs from "fs";
import path from "path";
import readline from "readline";
import { spawn } from "child_process";
import { npm, projectDir } from "./constants.js";

export function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    stdio?: "inherit" | "pipe";
    allowFailure?: boolean;
    shell?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: options.stdio ?? "inherit",
      env: process.env,
      shell: options.shell ?? false,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          killed = true;
          child.kill();
        }, options.timeoutMs)
      : undefined;

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (killed) {
        if (options.allowFailure) {
          resolve({ code: 1, stdout, stderr: stderr + "\n(timed out)" });
          return;
        }
        reject(new Error(`Command timed out: ${command} ${args.join(" ")}`));
        return;
      }
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !options.allowFailure) {
        reject(new Error(`Command failed: ${command} ${args.join(" ")}`));
        return;
      }

      resolve({ code: exitCode, stdout, stderr });
    });
  });
}

export async function capture(
  command: string,
  args: string[],
  cwd?: string,
): Promise<string> {
  const result = await runCommand(command, args, { stdio: "pipe", cwd });
  return result.stdout.trim();
}

export async function prompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return "";
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

export function normalizeYesNo(input: string, defaultYes = false): boolean {
  if (!input) {
    return defaultYes;
  }

  return /^[Yy]/.test(input);
}

export function ensureFile(filePath: string, fallback = "{}\n"): void {
  if (fs.existsSync(filePath)) {
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, fallback, "utf8");
}

export function readJson(filePath: string): Record<string, unknown> {
  ensureFile(filePath);

  try {
    const content = fs.readFileSync(filePath, "utf8").trim();
    if (!content) {
      return {};
    }

    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function writeJson(filePath: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function ensureExecutable(filePath: string): void {
  try {
    fs.chmodSync(filePath, 0o755);
  } catch {
    // Ignore on filesystems/platforms that do not support chmod.
  }
}

export function pathExistsAndNonEmpty(filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const content = fs.readFileSync(filePath, "utf8").trim();
  return content !== "" && content !== "{}";
}

export async function runBuild(): Promise<void> {
  // Skip build when installed globally (dist/ already bundled, no package.json scripts)
  const pkgPath = path.join(projectDir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    return;
  }
  console.log("Building project...");
  await runCommand(npm, ["run", "build"], { cwd: projectDir, shell: true });
}

export function escapeSingleQuotes(input: string): string {
  return input.replace(/'/g, "'\\''");
}
