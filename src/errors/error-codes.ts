export const ERROR_CODES = {
  SESSION_CLOSED: "SESSION_CLOSED",
  CLAUDE_PROCESS_FAILED: "CLAUDE_PROCESS_FAILED",
  CLAUDE_SESSION_NOT_FOUND: "CLAUDE_SESSION_NOT_FOUND",
  CLAUDE_CLI_NOT_FOUND: "CLAUDE_CLI_NOT_FOUND",
  CLAUDE_AUTH_REQUIRED: "CLAUDE_AUTH_REQUIRED",
  CLAUDE_RATE_LIMITED: "CLAUDE_RATE_LIMITED",
  CLAUDE_CONTEXT_TOO_LONG: "CLAUDE_CONTEXT_TOO_LONG",
  CLAUDE_TIMEOUT: "CLAUDE_TIMEOUT",
  SET_PERMISSION_MODE_FAILED: "SET_PERMISSION_MODE_FAILED",
  SET_MODEL_FAILED: "SET_MODEL_FAILED",
  STOP_TASK_FAILED: "STOP_TASK_FAILED",
  INTERRUPT_FAILED: "INTERRUPT_FAILED",
  STREAM_WITHOUT_QUERY: "STREAM_WITHOUT_QUERY",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const FRIENDLY_ERROR_MESSAGES: Record<ErrorCode, string> = {
  SESSION_CLOSED: "This session is already closed. Use `/new` to start a fresh session.",
  CLAUDE_PROCESS_FAILED:
    "Something went wrong with Claude Code. Try `/new` to start a fresh session.",
  CLAUDE_SESSION_NOT_FOUND:
    "Session not found. The Terminal session may have been deleted. Try `/new` to start fresh.",
  CLAUDE_CLI_NOT_FOUND:
    "Could not start Claude Code. The bot service may need to be restarted.",
  CLAUDE_AUTH_REQUIRED:
    "Claude login expired. Run `claude login` in your terminal, then try again.",
  CLAUDE_RATE_LIMITED:
    "Claude API is rate limited. Please wait a moment and try again.",
  CLAUDE_CONTEXT_TOO_LONG:
    "Conversation is too long. Use `/new` to start a fresh session.",
  CLAUDE_TIMEOUT: "Request timed out. Please try again.",
  SET_PERMISSION_MODE_FAILED: "Failed to update permission mode on active session.",
  SET_MODEL_FAILED: "Failed to update model on active session.",
  STOP_TASK_FAILED: "Failed to stop the requested task.",
  INTERRUPT_FAILED: "Failed to interrupt the active session.",
  STREAM_WITHOUT_QUERY: "Cannot continue this session right now. Use `/new` to start fresh.",
};
