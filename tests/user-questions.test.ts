import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildAskUserQuestionCard } from "../src/bot/cards.js";
import {
  buildAskUserQuestionResponse,
  clearPendingUserQuestions,
  type AskUserQuestionInput,
} from "../src/claude/user-questions.js";
import {
  createPermissionHandler,
  clearPendingPermissions,
} from "../src/claude/permissions.js";

describe("user-questions", () => {
  beforeEach(() => {
    clearPendingUserQuestions();
    clearPendingPermissions();
  });

  afterEach(() => {
    clearPendingUserQuestions();
    clearPendingPermissions();
  });

  it("generates Adaptive Card for single and multi-select questions", () => {
    const input: AskUserQuestionInput = {
      questions: [
        {
          header: "Format",
          question: "How should I format the output?",
          options: [
            { label: "Summary", description: "Brief overview" },
            { label: "Detailed", description: "Full explanation" },
          ],
          multiSelect: false,
        },
        {
          header: "Sections",
          question: "Which sections?",
          options: [{ label: "Option1" }, { label: "Option2" }],
          multiSelect: true,
        },
      ],
    };

    const card = buildAskUserQuestionCard(input, "tool-q-1");
    const body = card.body as Array<Record<string, unknown>>;

    const choiceSets = body.filter((item) => item.type === "Input.ChoiceSet");
    expect(choiceSets).toHaveLength(2);
    expect(choiceSets[0]?.id).toBe("question_0");
    expect(choiceSets[0]?.isMultiSelect).toBe(false);
    expect(choiceSets[1]?.id).toBe("question_1");
    expect(choiceSets[1]?.isMultiSelect).toBe(true);

    const actions = card.actions as Array<Record<string, unknown>>;
    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe("Action.Submit");
    expect(actions[0]?.data).toEqual({
      action: "ask_user_question_submit",
      toolUseID: "tool-q-1",
    });
  });

  it("formats answers for SDK response", () => {
    const input: AskUserQuestionInput = {
      questions: [
        {
          header: "Format",
          question: "How should I format the output?",
          options: [{ label: "Summary" }, { label: "Detailed" }],
          multiSelect: false,
        },
        {
          header: "Sections",
          question: "Which sections?",
          options: [{ label: "Option1" }, { label: "Option2" }],
          multiSelect: true,
        },
      ],
    };

    const response = buildAskUserQuestionResponse(input, {
      question_0: "Summary",
      question_1: "Option1, Option2",
    });

    expect(response).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: input.questions,
        answers: {
          "How should I format the output?": "Summary",
          "Which sections?": "Option1, Option2",
        },
      },
    });
  });

  it("adds free-text input when allowFreeText is enabled", () => {
    const input: AskUserQuestionInput = {
      questions: [
        {
          header: "Format",
          question: "How should I format the output?",
          options: [{ label: "Summary" }, { label: "Detailed" }],
          allowFreeText: true,
        },
      ],
    };

    const card = buildAskUserQuestionCard(input, "tool-q-3");
    const body = card.body as Array<Record<string, unknown>>;

    const textInput = body.find(
      (item) => item.type === "Input.Text" && item.id === "freetext_0",
    );
    expect(textInput).toBeDefined();
  });

  it("includes free-text response when provided", () => {
    const input: AskUserQuestionInput = {
      questions: [
        {
          header: "Format",
          question: "How should I format the output?",
          options: [{ label: "Summary" }, { label: "Detailed" }],
          allowFreeText: true,
        },
      ],
    };

    const response = buildAskUserQuestionResponse(input, {
      question_0: "Summary",
      freetext_0: "Use markdown tables and include code examples.",
    });

    expect(response).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: input.questions,
        answers: {
          "How should I format the output?":
            "Summary\nUse markdown tables and include code examples.",
        },
      },
    });
  });

  it("integrates with canUseTool handler for AskUserQuestion", async () => {
    const sendCard = vi.fn().mockResolvedValue(undefined);
    const handler = createPermissionHandler(sendCard);

    const input = {
      questions: [
        {
          header: "Format",
          question: "How should I format the output?",
          options: [{ label: "Summary" }, { label: "Detailed" }],
          multiSelect: false,
        },
      ],
    };

    const resultPromise = handler("AskUserQuestion", input, {
      signal: new AbortController().signal,
      toolUseID: "tool-q-2",
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sendCard).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "AskUserQuestion",
        input,
        toolUseID: "tool-q-2",
      }),
    );

    const { resolveAskUserQuestion } =
      await import("../src/claude/user-questions.js");
    resolveAskUserQuestion("tool-q-2", { question_0: "Summary" });

    const result = await resultPromise;
    expect(result).toEqual({
      behavior: "allow",
      toolUseID: "tool-q-2",
      updatedInput: {
        questions: input.questions,
        answers: {
          "How should I format the output?": "Summary",
        },
      },
    });
  });
});
