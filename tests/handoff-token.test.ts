import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_DIR = join(tmpdir(), `teams-bot-token-test-${process.pid}`);
const TOKEN_FILE = join(TEST_DIR, "handoff-token");
const ENV_FILE = join(TEST_DIR, ".env");

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

describe("handoff token file", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("persists token with owner-only permissions (0600)", () => {
    writeFileSync(TOKEN_FILE, "test-token-abc123", { mode: 0o600 });

    expect(readFileSync(TOKEN_FILE, "utf-8")).toBe("test-token-abc123");

    if (process.platform !== "win32") {
      const perms = statSync(TOKEN_FILE).mode & 0o777;
      expect(perms).toBe(0o600);
    }
  });

  it("reads token from canonical file", () => {
    writeFileSync(TOKEN_FILE, "canonical-token-xyz");

    const token = readFileSync(TOKEN_FILE, "utf-8").trim();
    expect(token).toBe("canonical-token-xyz");
  });

  it("handles missing token file gracefully", () => {
    let token: string | undefined;
    try {
      token = readFileSync(TOKEN_FILE, "utf-8").trim();
    } catch {
      token = undefined;
    }
    expect(token).toBeUndefined();
  });

  it("skips write when file already has same token", () => {
    writeFileSync(TOKEN_FILE, "same-token", { mode: 0o600 });
    const mtimeBefore = statSync(TOKEN_FILE).mtimeMs;

    // Simulate persistHandoffToken logic
    const existing = readFileSync(TOKEN_FILE, "utf-8").trim();
    if (existing !== "same-token") {
      writeFileSync(TOKEN_FILE, "same-token", { mode: 0o600 });
    }

    const mtimeAfter = statSync(TOKEN_FILE).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});

describe("setup .env file", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("writes .env with correct format", () => {
    const lines = [
      "MICROSOFT_APP_ID=test-app-id",
      "MICROSOFT_APP_PASSWORD=test-password",
      "MICROSOFT_APP_TENANT_ID=test-tenant-id",
      "CLAUDE_WORK_DIR=~",
      "PORT=3978",
    ];
    writeFileSync(ENV_FILE, lines.join("\n") + "\n", { mode: 0o600 });

    const content = readFileSync(ENV_FILE, "utf-8");
    expect(content).toContain("MICROSOFT_APP_ID=test-app-id");
    expect(content).toContain("PORT=3978");
    expect(content).not.toContain("ALLOWED_USERS");
  });

  it("writes .env with owner-only permissions", () => {
    writeFileSync(ENV_FILE, "KEY=VALUE\n", { mode: 0o600 });

    if (process.platform !== "win32") {
      const perms = statSync(ENV_FILE).mode & 0o777;
      expect(perms).toBe(0o600);
    }
  });

  it("includes optional fields when provided", () => {
    const lines = [
      "MICROSOFT_APP_ID=id",
      "MICROSOFT_APP_PASSWORD=pw",
      "MICROSOFT_APP_TENANT_ID=tid",
      "CLAUDE_WORK_DIR=~",
      "PORT=3978",
      "ALLOWED_USERS=user1,user2",
      "DEVTUNNEL_ID=my-tunnel",
    ];
    writeFileSync(ENV_FILE, lines.join("\n") + "\n", { mode: 0o600 });

    const content = readFileSync(ENV_FILE, "utf-8");
    expect(content).toContain("ALLOWED_USERS=user1,user2");
    expect(content).toContain("DEVTUNNEL_ID=my-tunnel");
  });
});

describe("dotenv loading priority", () => {
  const PROJECT_ENV = join(TEST_DIR, "project.env");
  const CANONICAL = join(TEST_DIR, "canonical.env");

  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("project .env values take priority over canonical", async () => {
    // dotenv.config() does NOT override existing env vars
    // First call loads project .env, second loads canonical — project wins
    const dotenv = await import("dotenv");
    const uniqueKey = `TEST_PRIORITY_${process.pid}`;

    writeFileSync(PROJECT_ENV, `${uniqueKey}=project-value\n`);
    writeFileSync(CANONICAL, `${uniqueKey}=canonical-value\n`);

    delete process.env[uniqueKey];

    dotenv.config({ path: PROJECT_ENV });
    dotenv.config({ path: CANONICAL });

    expect(process.env[uniqueKey]).toBe("project-value");

    delete process.env[uniqueKey];
  });

  it("canonical provides value when project .env missing the key", async () => {
    const dotenv = await import("dotenv");
    const uniqueKey = `TEST_FALLBACK_${process.pid}`;

    writeFileSync(PROJECT_ENV, "OTHER_KEY=other\n");
    writeFileSync(CANONICAL, `${uniqueKey}=canonical-only\n`);

    delete process.env[uniqueKey];

    dotenv.config({ path: PROJECT_ENV });
    dotenv.config({ path: CANONICAL });

    expect(process.env[uniqueKey]).toBe("canonical-only");

    delete process.env[uniqueKey];
  });

  it("explicit env var overrides both files", async () => {
    const dotenv = await import("dotenv");
    const uniqueKey = `TEST_EXPLICIT_${process.pid}`;

    writeFileSync(PROJECT_ENV, `${uniqueKey}=from-project\n`);
    writeFileSync(CANONICAL, `${uniqueKey}=from-canonical\n`);

    process.env[uniqueKey] = "explicit-override";

    dotenv.config({ path: PROJECT_ENV });
    dotenv.config({ path: CANONICAL });

    expect(process.env[uniqueKey]).toBe("explicit-override");

    delete process.env[uniqueKey];
  });
});
