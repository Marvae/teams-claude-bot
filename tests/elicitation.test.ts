import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildElicitationCard,
  buildElicitationUrlCard,
  clearPendingElicitations,
  registerElicitation,
  resolveElicitation,
  resolveElicitationUrlComplete,
  type ElicitationRequest,
} from "../src/claude/elicitation.js";
// After removing wrapper functions from cards.ts, these are now
// the same as buildElicitationCard/buildElicitationUrlCard above.
const buildElicitationFormCard = buildElicitationCard;
const buildTeamsElicitationUrlCard = buildElicitationUrlCard;

describe("elicitation", () => {
  beforeEach(() => {
    clearPendingElicitations();
  });

  afterEach(() => {
    clearPendingElicitations();
  });

  it("builds form card data from JSON schema", () => {
    const request: ElicitationRequest = {
      serverName: "github-mcp",
      message: "Provide repository details",
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: {
          owner: { type: "string", title: "Owner" },
          repo: { type: "string", title: "Repository" },
          token: { type: "string", title: "Access Token" },
        },
        required: ["owner", "repo"],
      },
    };

    const cardData = buildElicitationCard("elicitation-form-1", request);
    const textInputs = cardData.body.filter(
      (item) => item.type === "Input.Text",
    );

    expect(textInputs).toHaveLength(3);
    expect(textInputs.map((item) => item.id)).toEqual([
      "field_owner",
      "field_repo",
      "field_token",
    ]);

    const submit = cardData.actions[0];
    expect(submit?.data).toEqual({
      action: "elicitation_form_submit",
      elicitationId: "elicitation-form-1",
    });
  });

  it("builds URL card data", () => {
    const request: ElicitationRequest = {
      serverName: "github-mcp",
      message: "Authorize GitHub access",
      mode: "url",
      url: "https://example.com/oauth",
      elicitationId: "oauth-1",
    };

    const cardData = buildElicitationUrlCard("elicitation-url-1", request);

    expect(cardData.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "TextBlock",
          text: expect.stringContaining("Authorize GitHub access"),
        }),
        expect.objectContaining({
          type: "TextBlock",
          text: expect.stringContaining("https://example.com/oauth"),
        }),
      ]),
    );

    expect(cardData.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Open Authorization URL",
          url: "https://example.com/oauth",
        }),
        expect.objectContaining({
          title: "I've authorized",
          data: {
            action: "elicitation_url_complete",
            elicitationId: "elicitation-url-1",
          },
        }),
      ]),
    );
  });

  it("wraps form card data in Teams Adaptive Card", () => {
    const request: ElicitationRequest = {
      serverName: "github-mcp",
      message: "Provide repository details",
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: {
          owner: { type: "string", title: "Owner" },
        },
      },
    };

    const card = buildElicitationFormCard("elicitation-form-2", request);
    expect(card.type).toBe("AdaptiveCard");

    const actions = card.actions as Array<Record<string, unknown>>;
    expect(actions[0]?.data).toEqual({
      action: "elicitation_form_submit",
      elicitationId: "elicitation-form-2",
    });
  });

  it("wraps URL card data in Teams Adaptive Card", () => {
    const request: ElicitationRequest = {
      serverName: "github-mcp",
      message: "Authorize access",
      mode: "url",
      url: "https://example.com/oauth",
      elicitationId: "oauth-2",
    };

    const card = buildTeamsElicitationUrlCard("elicitation-url-2", request);
    expect(card.type).toBe("AdaptiveCard");

    const actions = card.actions as Array<Record<string, unknown>>;
    expect(actions.some((action) => action.type === "Action.OpenUrl")).toBe(
      true,
    );
    expect(
      actions.some(
        (action) =>
          action.type === "Action.Execute" &&
          action.data &&
          typeof action.data === "object" &&
          (action.data as { action?: string }).action ===
            "elicitation_url_complete",
      ),
    ).toBe(true);
  });

  it("resolves form elicitation with submitted values", async () => {
    const promise = registerElicitation("elicitation-form-3", {
      timeoutMs: 5000,
    });

    const resolved = resolveElicitation("elicitation-form-3", {
      field_owner: "anthropic",
      field_repo: "claude-code",
    });

    expect(resolved).toBe(true);
    await expect(promise).resolves.toEqual({
      action: "accept",
      content: {
        owner: "anthropic",
        repo: "claude-code",
      },
    });
  });

  it("resolves URL elicitation completion", async () => {
    const promise = registerElicitation("elicitation-url-3", {
      timeoutMs: 5000,
    });

    const resolved = resolveElicitationUrlComplete("elicitation-url-3");
    expect(resolved).toBe(true);

    await expect(promise).resolves.toEqual({ action: "accept" });
  });

  it("times out pending elicitation", async () => {
    vi.useFakeTimers();

    try {
      const promise = registerElicitation("elicitation-timeout", {
        timeoutMs: 3000,
      });

      vi.advanceTimersByTime(3000);

      await expect(promise).resolves.toEqual({
        action: "decline",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
