import type {
  CanUseTool as SDKCanUseTool,
  PermissionResult as SDKPermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import { handleAskUserQuestion } from "./user-questions.js";
import { logError, logInfo } from "../logging/logger.js";

export type PermissionRequest = {
  toolName: string;
  input: Record<string, unknown>;
  toolUseID: string;
  decisionReason?: string;
  blockedPath?: string;
  suggestions?: PermissionUpdate[];
};

export type PermissionResult = SDKPermissionResult;

export type PermissionHandlerOptions = {
  timeoutMs?: number;
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

export function createPermissionHandler(
  sendCard: (request: PermissionRequest) => Promise<void>,
  options?: PermissionHandlerOptions,
) {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return (async (
    toolName: string,
    input: Record<string, unknown>,
    opts: Parameters<SDKCanUseTool>[2],
  ): Promise<PermissionResult> => {
    const { toolUseID, decisionReason, blockedPath, suggestions } = opts;
    logInfo("PERM", "request_received", {
      toolName,
      toolUseID,
      hasSuggestions: Array.isArray(suggestions) && suggestions.length > 0,
      hasBlockedPath: !!blockedPath,
      hasDecisionReason: !!decisionReason,
    });

    if (toolName === "AskUserQuestion") {
      return handleAskUserQuestion(input, {
        toolUseID,
        sendCard,
        timeoutMs,
      });
    }

    // Send card to user
    try {
      await sendCard({
        toolName,
        input,
        toolUseID,
        decisionReason,
        blockedPath,
        suggestions,
      });
      logInfo("PERM", "card_sent", { toolName, toolUseID });
    } catch (error) {
      logError("PERM", "card_send_failed", error, { toolName, toolUseID });
      return {
        behavior: "deny",
        message: "Permission request failed to send",
        toolUseID,
      };
    }

    // Wait for user response or timeout
    return new Promise<PermissionResult>((resolve) => {
      const timeout = setTimeout(() => {
        pendingPermissions.delete(toolUseID);
        logInfo("PERM", "request_timed_out", { toolName, toolUseID });
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

      logInfo("PERM", "request_pending", { toolName, toolUseID });
    });
  }) satisfies SDKCanUseTool;
}

export function resolvePermission(toolUseID: string, allow: boolean): boolean {
  const pending = pendingPermissions.get(toolUseID);
  if (!pending) return false;

  clearTimeout(pending.timeout);
  pendingPermissions.delete(toolUseID);

  if (allow) {
    logInfo("PERM", "resolved", { toolUseID, behavior: "allow" });
    pending.resolve({
      behavior: "allow",
      updatedInput: pending.input,
      toolUseID,
    });
  } else {
    logInfo("PERM", "resolved", { toolUseID, behavior: "deny" });
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
  logInfo("PERM", "resolved_with_suggestion", {
    toolUseID,
    suggestionIndex,
    hasSelected: !!selected,
  });
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
  logInfo("PERM", "pending_cleared", { count: pendingPermissions.size });
  pendingPermissions.clear();
}
