import type {
  CanUseTool as SDKCanUseTool,
  PermissionResult as SDKPermissionResult,
} from "@anthropic-ai/claude-agent-sdk";

export type PermissionRequest = {
  toolName: string;
  input: Record<string, unknown>;
  toolUseID: string;
  decisionReason?: string;
  blockedPath?: string;
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
    const { toolUseID, decisionReason, blockedPath } = opts;

    // Send card to user
    await sendCard({ toolName, input, toolUseID, decisionReason, blockedPath });

    // Wait for user response or timeout
    return new Promise<PermissionResult>((resolve) => {
      const timeout = setTimeout(() => {
        pendingPermissions.delete(toolUseID);
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

export function clearPendingPermissions(): void {
  for (const pending of pendingPermissions.values()) {
    clearTimeout(pending.timeout);
  }
  pendingPermissions.clear();
}
