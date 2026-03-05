import type {
  CanUseTool as SDKCanUseTool,
  PermissionResult as SDKPermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import { handleAskUserQuestion } from "./user-questions.js";

export type PermissionRequest = {
  toolName: string;
  input: Record<string, unknown>;
  toolUseID: string;
  decisionReason?: string;
  blockedPath?: string;
  suggestions?: PermissionUpdate[];
};

export type PermissionResult = SDKPermissionResult;

export type ToolInterceptorOptions = {
  timeoutMs?: number;
  onTimeout?: (toolUseID: string) => void;
};

type PendingPermission = {
  resolve: (result: PermissionResult) => void;
  timeout: NodeJS.Timeout;
  toolUseID: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
};

const pendingPermissions = new Map<string, PendingPermission>();

const DEFAULT_TIMEOUT_MS = 60_000;

export function createToolInterceptor(
  sendCard: (request: PermissionRequest) => Promise<void>,
  options?: ToolInterceptorOptions,
) {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return (async (
    toolName: string,
    input: Record<string, unknown>,
    opts: Parameters<SDKCanUseTool>[2],
  ): Promise<PermissionResult> => {
    const { toolUseID, decisionReason, blockedPath, suggestions } = opts;
    console.log(`[PERM] canUseTool called: tool=${toolName}, suggestions=${JSON.stringify(suggestions)}`);

    if (toolName === "AskUserQuestion") {
      return handleAskUserQuestion(input, {
        toolUseID,
        sendCard,
        timeoutMs,
        onTimeout: options?.onTimeout,
      });
    }

    // Send card to user
    await sendCard({ toolName, input, toolUseID, decisionReason, blockedPath, suggestions });

    // Wait for user response or timeout
    return new Promise<PermissionResult>((resolve) => {
      const timeout = setTimeout(() => {
        pendingPermissions.delete(toolUseID);
        options?.onTimeout?.(toolUseID);
        resolve({
          behavior: "deny",
          message: "Permission request timed out",
          toolUseID,
        });
      }, timeoutMs);

      pendingPermissions.set(toolUseID, {
        resolve,
        timeout,
        toolUseID,
        input,
        suggestions,
      });
    });
  }) satisfies SDKCanUseTool;
}

export function resolvePermission(toolUseID: string, allow: boolean): boolean {
  const pending = pendingPermissions.get(toolUseID);
  if (!pending) return false;

  clearTimeout(pending.timeout);
  pendingPermissions.delete(toolUseID);

  if (allow) {
    pending.resolve({
      behavior: "allow",
      updatedInput: pending.input,
      toolUseID,
    });
  } else {
    pending.resolve({
      behavior: "deny",
      message: "User denied permission",
      toolUseID,
    });
  }

  return true;
}

export function resolvePermissionWithSuggestion(
  toolUseID: string,
  suggestionIndex: number,
): boolean {
  const pending = pendingPermissions.get(toolUseID);
  if (!pending) return false;

  clearTimeout(pending.timeout);
  pendingPermissions.delete(toolUseID);

  const selected = pending.suggestions?.[suggestionIndex];
  pending.resolve({
    behavior: "allow",
    updatedInput: pending.input,
    updatedPermissions: selected ? [selected] : pending.suggestions,
    toolUseID,
  });
  return true;
}

export function clearPendingPermissions(): void {
  for (const pending of pendingPermissions.values()) {
    clearTimeout(pending.timeout);
  }
  pendingPermissions.clear();
}
