export type PermissionRequest = {
  toolName: string;
  input: Record<string, unknown>;
  toolUseID: string;
  decisionReason?: string;
  blockedPath?: string;
};

export type PermissionResult =
  | {
      behavior: "allow";
      toolUseID?: string;
    }
  | {
      behavior: "deny";
      message: string;
      toolUseID?: string;
    };

export type PermissionHandlerOptions = {
  timeoutMs?: number;
};

type PendingPermission = {
  resolve: (result: PermissionResult) => void;
  timeout: NodeJS.Timeout;
  toolUseID: string;
};

const pendingPermissions = new Map<string, PendingPermission>();

const DEFAULT_TIMEOUT_MS = 60_000;

export function createPermissionHandler(
  sendCard: (request: PermissionRequest) => Promise<void>,
  options?: PermissionHandlerOptions,
) {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (
    toolName: string,
    input: Record<string, unknown>,
    opts: {
      signal: AbortSignal;
      toolUseID: string;
      decisionReason?: string;
      blockedPath?: string;
    },
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

      pendingPermissions.set(toolUseID, { resolve, timeout, toolUseID });
    });
  };
}

export function resolvePermission(toolUseID: string, allow: boolean): boolean {
  const pending = pendingPermissions.get(toolUseID);
  if (!pending) return false;

  clearTimeout(pending.timeout);
  pendingPermissions.delete(toolUseID);

  if (allow) {
    pending.resolve({ behavior: "allow", toolUseID });
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
