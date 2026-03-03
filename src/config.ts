import "dotenv/config";
import { homedir } from "os";
import { resolve } from "path";

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
  claudeWorkDir: expandHome(process.env.CLAUDE_WORK_DIR ?? "~/Work"),
  allowedUsers: parseAllowedUsers(process.env.ALLOWED_USERS),
  handoffToken: process.env.HANDOFF_TOKEN ?? "",
} as const;
