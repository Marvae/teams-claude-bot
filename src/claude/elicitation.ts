import type {
  ElicitationRequest as SDKElicitationRequest,
  ElicitationResult as SDKElicitationResult,
} from "@anthropic-ai/claude-agent-sdk";
import type { CardElement, AdaptiveCard } from "@microsoft/teams.cards";
import {
  TextBlock,
  TextInput,
  ExecuteAction,
  OpenUrlAction,
} from "@microsoft/teams.cards";
import { adaptiveCard } from "../bot/cards.js";

export type ElicitationRequest = SDKElicitationRequest;
export type ElicitationResult = SDKElicitationResult;

type PendingElicitation = {
  resolve: (result: ElicitationResult) => void;
  timeout: NodeJS.Timeout;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const pendingElicitations = new Map<string, PendingElicitation>();

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function schemaProperties(
  schema?: Record<string, unknown>,
): Array<[string, Record<string, unknown>]> {
  const props = asRecord(schema?.properties);
  if (!props) return [];
  return Object.entries(props).filter(
    (entry): entry is [string, Record<string, unknown>] => {
      const field = asRecord(entry[1]);
      return !!field;
    },
  );
}

function schemaRequired(schema?: Record<string, unknown>): Set<string> {
  const required = schema?.required;
  if (!Array.isArray(required)) return new Set<string>();
  return new Set(required.filter((v): v is string => typeof v === "string"));
}

function fieldId(name: string): string {
  return `field_${name}`;
}

type ElicitationContent = { [x: string]: string | number | boolean | string[] };

function collectFormContent(data: Record<string, unknown>): ElicitationContent {
  const content: ElicitationContent = {};

  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith("field_")) continue;
    if (typeof value !== "string") continue;

    const fieldName = key.slice("field_".length);
    const trimmed = value.trim();
    if (fieldName && trimmed.length > 0) {
      content[fieldName] = trimmed;
    }
  }

  return content;
}

export function buildElicitationCard(
  elicitationId: string,
  request: ElicitationRequest,
): AdaptiveCard {
  const fields = schemaProperties(request.requestedSchema);
  const required = schemaRequired(request.requestedSchema);

  const body: CardElement[] = [
    new TextBlock(`**${request.serverName}**`, { size: "Small" }),
    new TextBlock(request.message, {
      wrap: true,
      size: "Small",
      spacing: "Small",
    }),
  ];

  if (fields.length === 0) {
    body.push(
      new TextBlock("No form fields were provided by the MCP server.", {
        wrap: true,
        isSubtle: true,
      }),
    );
  }

  for (const [name, definition] of fields) {
    const title =
      typeof definition.title === "string" && definition.title.length > 0
        ? definition.title
        : name;
    const description =
      typeof definition.description === "string"
        ? definition.description
        : undefined;
    const requiredSuffix = required.has(name) ? " *" : "";

    body.push(
      new TextBlock(`${title}${requiredSuffix}`, {
        wrap: true,
        spacing: "Medium",
      }),
      new TextInput({
        id: fieldId(name),
        placeholder: description ?? `Enter ${title}`,
        isMultiline: false,
      }),
    );
  }

  const card = adaptiveCard(...body);
  card.actions = [
    new ExecuteAction({
      title: "Submit",
      style: "positive",
      data: {
        action: "elicitation_form_submit",
        elicitationId,
      },
    }),
    new ExecuteAction({
      title: "Cancel",
      data: {
        action: "elicitation_form_cancel",
        elicitationId,
      },
    }),
  ];

  return card;
}

export function buildElicitationUrlCard(
  elicitationId: string,
  request: ElicitationRequest,
): AdaptiveCard {
  const body = [
    new TextBlock(`🔑 **${request.serverName}**`, { size: "Small" }),
    new TextBlock(request.message, {
      wrap: true,
      size: "Small",
      spacing: "Small",
    }),
  ];

  if (request.url) {
    body.push(
      new TextBlock(request.url, {
        wrap: true,
        color: "Accent",
        spacing: "Medium",
      }),
    );
  }

  const card = adaptiveCard(...body);

  const actions = [];

  if (request.url) {
    actions.push(
      new OpenUrlAction(request.url, { title: "Open Authorization URL" }),
    );
  }

  actions.push(
    new ExecuteAction({
      title: "I've authorized",
      style: "positive",
      data: {
        action: "elicitation_url_complete",
        elicitationId,
      },
    }),
    new ExecuteAction({
      title: "Cancel",
      data: {
        action: "elicitation_form_cancel",
        elicitationId,
      },
    }),
  );

  card.actions = actions;
  return card;
}

export function registerElicitation(
  elicitationId: string,
  opts?: { timeoutMs?: number; onTimeout?: (elicitationId: string) => void },
): Promise<ElicitationResult> {
  if (pendingElicitations.has(elicitationId)) {
    return Promise.reject(
      new Error(`Elicitation request ${elicitationId} already exists`),
    );
  }

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<ElicitationResult>((resolve) => {
    const timeout = setTimeout(() => {
      pendingElicitations.delete(elicitationId);
      opts?.onTimeout?.(elicitationId);
      resolve({ action: "decline" });
    }, timeoutMs);

    pendingElicitations.set(elicitationId, { resolve, timeout });
  });
}

export function resolveElicitation(
  elicitationId: string,
  rawValues: Record<string, unknown>,
): boolean {
  const pending = pendingElicitations.get(elicitationId);
  if (!pending) return false;

  clearTimeout(pending.timeout);
  pendingElicitations.delete(elicitationId);

  pending.resolve({
    action: "accept",
    content: collectFormContent(rawValues),
  });

  return true;
}

export function resolveElicitationUrlComplete(elicitationId: string): boolean {
  const pending = pendingElicitations.get(elicitationId);
  if (!pending) return false;

  clearTimeout(pending.timeout);
  pendingElicitations.delete(elicitationId);
  pending.resolve({ action: "accept" });
  return true;
}

export function cancelElicitation(elicitationId: string): boolean {
  const pending = pendingElicitations.get(elicitationId);
  if (!pending) return false;

  clearTimeout(pending.timeout);
  pendingElicitations.delete(elicitationId);
  pending.resolve({ action: "cancel" });
  return true;
}

export async function handleElicitation(
  request: ElicitationRequest,
  sendCard: (
    elicitationId: string,
    request: ElicitationRequest,
  ) => Promise<void>,
  opts?: { timeoutMs?: number; onTimeout?: (elicitationId: string) => void },
): Promise<ElicitationResult> {
  const baseId = request.elicitationId?.trim();
  const fallbackId = `${request.serverName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const elicitationId = baseId && baseId.length > 0 ? baseId : fallbackId;

  await sendCard(elicitationId, request);

  return registerElicitation(elicitationId, opts);
}

export function clearPendingElicitations(): void {
  for (const pending of pendingElicitations.values()) {
    clearTimeout(pending.timeout);
  }
  pendingElicitations.clear();
}
