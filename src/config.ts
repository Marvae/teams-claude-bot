import dotenv from "dotenv";
import { randomBytes } from "crypto";
import { homedir } from "os";
import { resolve, dirname } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { CANONICAL_ENV_PATH, HANDOFF_TOKEN_PATH } from "./paths.js";

// Load config: env vars (highest) > cwd/.env (repo dev) > canonical (npm/setup)
dotenv.config();
dotenv.config({ path: CANONICAL_ENV_PATH });

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

function persistHandoffToken(token: string): void {
  try {
    mkdirSync(dirname(HANDOFF_TOKEN_PATH), { recursive: true });
    // Skip write if file already has the same token
    if (existsSync(HANDOFF_TOKEN_PATH)) {
      const existing = readFileSync(HANDOFF_TOKEN_PATH, "utf-8").trim();
      if (existing === token) return;
    }
    writeFileSync(HANDOFF_TOKEN_PATH, token, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    /* best-effort */
  }
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
    if (token) {
      persistHandoffToken(token);
      return token;
    }
    // Try canonical file before generating a new one
    try {
      if (existsSync(HANDOFF_TOKEN_PATH)) {
        const saved = readFileSync(HANDOFF_TOKEN_PATH, "utf-8").trim();
        if (saved) return saved;
      }
    } catch {
      /* ignore */
    }
    // Auto-generate and persist to canonical file only
    const generated = randomBytes(32).toString("hex");
    persistHandoffToken(generated);
    return generated;
  })(),
  sessionInitPrompt: process.env.SESSION_INIT_PROMPT,
} as const;
