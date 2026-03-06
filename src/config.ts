import "dotenv/config";
import { randomBytes } from "crypto";
import { homedir } from "os";
import { resolve } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p);
}

function parseAllowedUsers(raw?: string): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export const config = {
  microsoftAppId: required("MICROSOFT_APP_ID"),
  microsoftAppPassword: required("MICROSOFT_APP_PASSWORD"),
  microsoftAppTenantId: required("MICROSOFT_APP_TENANT_ID"),
  port: parseInt(process.env.PORT ?? "3978", 10),
  claudeWorkDir: (() => {
    const dir = expandHome(required("CLAUDE_WORK_DIR"));
    if (!existsSync(dir)) {
      throw new Error(`CLAUDE_WORK_DIR does not exist: ${dir}`);
    }
    return dir;
  })(),
  allowedUsers: parseAllowedUsers(process.env.ALLOWED_USERS),
  handoffToken: (() => {
    const token = process.env.HANDOFF_TOKEN;
    if (token) return token;
    // Auto-generate and persist to .env so it survives restarts
    const generated = randomBytes(32).toString("hex");
    const envPath = resolve(process.cwd(), ".env");
    try {
      const envContent = existsSync(envPath)
        ? readFileSync(envPath, "utf-8")
        : "";
      if (!envContent.match(/^HANDOFF_TOKEN=.+$/m)) {
        const updated = envContent.match(/^HANDOFF_TOKEN=.*$/m)
          ? envContent.replace(/^HANDOFF_TOKEN=.*$/m, `HANDOFF_TOKEN=${generated}`)
          : envContent + `\nHANDOFF_TOKEN=${generated}\n`;
        writeFileSync(envPath, updated);
        console.log(`[SECURITY] Generated HANDOFF_TOKEN and saved to .env`);
      }
    } catch {
      console.warn(
        `[SECURITY] Could not write to .env — token is ephemeral`,
      );
    }
    return generated;
  })(),
  sessionInitPrompt: process.env.SESSION_INIT_PROMPT,
} as const;
