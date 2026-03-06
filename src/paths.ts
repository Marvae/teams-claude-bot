import { homedir } from "os";
import { resolve } from "path";

/** Root directory for all teams-bot runtime data. */
export const TEAMS_BOT_DATA_DIR = resolve(homedir(), ".claude", "teams-bot");

/** Canonical .env for npm / setup users (project .env takes priority via dotenv). */
export const CANONICAL_ENV_PATH = resolve(TEAMS_BOT_DATA_DIR, ".env");

/** Canonical location for the handoff token, shared across bot and CLI. */
export const HANDOFF_TOKEN_PATH = resolve(TEAMS_BOT_DATA_DIR, "handoff-token");
