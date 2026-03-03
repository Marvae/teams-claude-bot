import { vi } from "vitest";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import { join } from "path";

// Create a temp directory for tests
const testWorkDir = mkdtempSync(join(tmpdir(), "teams-bot-test-"));

// Mock the config module before any other imports
vi.mock("../src/config.js", () => ({
  config: {
    microsoftAppId: "test-app-id",
    microsoftAppPassword: "test-password",
    microsoftAppTenantId: "test-tenant-id",
    port: 3978,
    claudeWorkDir: testWorkDir,
    allowedUsers: new Set<string>(),
    handoffToken: "test-token",
    sessionInitPrompt: undefined,
  },
}));
