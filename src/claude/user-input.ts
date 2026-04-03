/**
 * User input handling for Claude SDK PromptRequest/PromptResponse
 *
 * SDK emits PromptRequest when it needs user input (e.g., confirmation).
 * We show an Adaptive Card and wait for user selection.
 */

import type { IAdaptiveCard } from "@microsoft/teams.cards";
import { TextBlock, ExecuteAction } from "@microsoft/teams.cards";
import { adaptiveCard } from "../bot/cards.js";

export type PromptRequestOption = {
  key: string;
  label: string;
  description?: string;
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
): IAdaptiveCard {
  return adaptiveCard(
    new TextBlock(message, { wrap: true, weight: "Bolder" }),
  ).withOptions({
    actions: options.map(
      (opt) =>
        new ExecuteAction({
          title: opt.label,
          data: {
            action: "prompt_response",
            requestId,
            key: opt.key,
          },
        }),
    ),
  });
}

export function registerPromptRequest(
  requestId: string,
  opts?: { timeoutMs?: number; onTimeout?: (requestId: string) => void },
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
      opts?.onTimeout?.(requestId);
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
