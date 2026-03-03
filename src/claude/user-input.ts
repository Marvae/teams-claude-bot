/**
 * User input handling for Claude SDK PromptRequest/PromptResponse
 *
 * SDK emits PromptRequest when it needs user input (e.g., confirmation).
 * We show an Adaptive Card and wait for user selection.
 */

export type PromptRequestOption = {
  key: string;
  label: string;
  description?: string;
};

type AdaptiveCard = {
  type: "AdaptiveCard";
  version: "1.4";
  $schema: string;
  body: Array<Record<string, unknown>>;
  actions: Array<{
    type: "Action.Submit";
    title: string;
    data: { action: "prompt_response"; requestId: string; key: string };
  }>;
};

type PendingPrompt = {
  resolve: (key: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

const pendingPrompts = new Map<string, PendingPrompt>();

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes for user input

export function createPromptCard(
  requestId: string,
  message: string,
  options: PromptRequestOption[],
): AdaptiveCard {
  return {
    type: "AdaptiveCard",
    version: "1.4",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    body: [
      {
        type: "TextBlock",
        text: message,
        wrap: true,
        weight: "bolder",
      },
    ],
    actions: options.map((opt) => ({
      type: "Action.Submit" as const,
      title: opt.label,
      data: {
        action: "prompt_response" as const,
        requestId,
        key: opt.key,
      },
    })),
  };
}

export function registerPromptRequest(
  requestId: string,
  opts?: { timeoutMs?: number },
): Promise<string> {
  if (pendingPrompts.has(requestId)) {
    return Promise.reject(
      new Error(`Prompt request ${requestId} already exists`),
    );
  }

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingPrompts.delete(requestId);
      reject(new Error("Prompt request timed out"));
    }, timeoutMs);

    pendingPrompts.set(requestId, { resolve, reject, timeout });
  });
}

export function resolvePromptRequest(
  requestId: string,
  selectedKey: string,
): boolean {
  const pending = pendingPrompts.get(requestId);
  if (!pending) return false;

  clearTimeout(pending.timeout);
  pendingPrompts.delete(requestId);
  pending.resolve(selectedKey);

  return true;
}

export function clearPendingPrompts(): void {
  for (const pending of pendingPrompts.values()) {
    clearTimeout(pending.timeout);
  }
  pendingPrompts.clear();
}
