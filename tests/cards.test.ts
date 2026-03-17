import { describe, it, expect } from "vitest";
import { buildToolCard } from "../src/bot/cards.js";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

describe("buildToolCard — ChoiceSet permission card", () => {
  it("renders a single ChoiceSet with Allow and Deny choices", () => {
    const card = buildToolCard(
      "Bash",
      { command: "ls -la" },
      "tool-1",
    ) as Record<string, unknown>;

    const body = card.body as Array<Record<string, unknown>>;
    const choiceSet = body.find((b) => b.type === "Input.ChoiceSet");
    expect(choiceSet).toBeDefined();
    expect(choiceSet!.id).toBe("permissionChoice");
    expect(choiceSet!.style).toBe("expanded");

    const choices = choiceSet!.choices as Array<{ title: string; value: string }>;
    expect(choices.length).toBe(2);
    expect(choices[0].value).toBe("allow");
    expect(choices[1].value).toBe("deny");

    const actions = card.actions as Array<Record<string, unknown>>;
    const submitAction = actions.find(
      (a) => (a.data as Record<string, unknown>)?.action === "permission_decision",
    );
    expect(submitAction).toBeDefined();
    expect(submitAction!.title).toBe("Submit");
  });

  it("includes suggestion choices when suggestions are provided", () => {
    const suggestions: PermissionUpdate[] = [
      {
        type: "addRules",
        destination: "session",
        rules: [{ toolName: "Bash", ruleContent: "/tmp" }],
      } as PermissionUpdate,
    ];

    const card = buildToolCard(
      "Bash",
      { command: "rm /tmp/test" },
      "tool-2",
      undefined,
      suggestions,
    ) as Record<string, unknown>;

    const body = card.body as Array<Record<string, unknown>>;
    const choiceSet = body.find((b) => b.type === "Input.ChoiceSet");
    const choices = choiceSet!.choices as Array<{ title: string; value: string }>;

    expect(choices.length).toBe(3);
    expect(choices[0].value).toBe("allow");
    expect(choices[1].value).toBe("suggestion_0");
    expect(choices[1].title).toContain("Bash");
    expect(choices[2].value).toBe("deny");
  });

  it("does not include ChoiceSet when result is provided (completed card)", () => {
    const card = buildToolCard(
      "Bash",
      { command: "echo hi" },
      "tool-3",
      undefined,
      undefined,
      "Allowed",
    ) as Record<string, unknown>;

    const body = card.body as Array<Record<string, unknown>>;
    const choiceSet = body.find((b) => b.type === "Input.ChoiceSet");
    expect(choiceSet).toBeUndefined();
    expect(card.actions).toBeUndefined();
  });

  it("defaults to allow selection", () => {
    const card = buildToolCard(
      "Read",
      { file_path: "src/index.ts" },
      "tool-4",
    ) as Record<string, unknown>;

    const body = card.body as Array<Record<string, unknown>>;
    const choiceSet = body.find((b) => b.type === "Input.ChoiceSet");
    expect(choiceSet!.value).toBe("allow");
  });
});
