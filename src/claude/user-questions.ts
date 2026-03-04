import type { PermissionRequest, PermissionResult } from "./permissions.js";

export type UserQuestionOption = {
  label: string;
  description?: string;
};

export type UserQuestion = {
  question: string;
  header: string;
  options: UserQuestionOption[];
  multiSelect?: boolean;
  allowFreeText?: boolean;
};

export type AskUserQuestionInput = {
  questions: UserQuestion[];
};

type AskUserQuestionCardData = {
  body: Array<Record<string, unknown>>;
  actions: Array<Record<string, unknown>>;
};

type PendingUserQuestion = {
  resolve: (result: PermissionResult) => void;
  timeout: NodeJS.Timeout;
  input: AskUserQuestionInput;
};

export type AskUserQuestionHandlerOptions = {
  timeoutMs?: number;
};

const pendingUserQuestions = new Map<string, PendingUserQuestion>();

const DEFAULT_TIMEOUT_MS = 120_000;

export function getQuestionInputId(index: number): string {
  return `question_${index}`;
}

function getFreeTextInputId(index: number): string {
  return `freetext_${index}`;
}

export function isAskUserQuestionInput(
  input: Record<string, unknown>,
): input is AskUserQuestionInput {
  if (!Array.isArray(input.questions)) {
    return false;
  }

  return input.questions.every((question) => {
    if (typeof question !== "object" || question === null) {
      return false;
    }

    const candidate = question as Record<string, unknown>;
    if (
      typeof candidate.question !== "string" ||
      typeof candidate.header !== "string" ||
      !Array.isArray(candidate.options)
    ) {
      return false;
    }

    if (
      candidate.multiSelect !== undefined &&
      typeof candidate.multiSelect !== "boolean"
    ) {
      return false;
    }

    if (
      candidate.allowFreeText !== undefined &&
      typeof candidate.allowFreeText !== "boolean"
    ) {
      return false;
    }

    return candidate.options.every((option) => {
      if (typeof option !== "object" || option === null) {
        return false;
      }
      const opt = option as Record<string, unknown>;
      return typeof opt.label === "string";
    });
  });
}

export function buildAskUserQuestionResponse(
  input: AskUserQuestionInput,
  rawAnswers: Record<string, unknown>,
): PermissionResult {
  const answers: Record<string, string> = {};

  for (const [index, question] of input.questions.entries()) {
    const key = getQuestionInputId(index);
    const raw = rawAnswers[key];
    const freeTextRaw = rawAnswers[getFreeTextInputId(index)];
    const freeText = typeof freeTextRaw === "string" ? freeTextRaw.trim() : "";
    let answer = "";

    if (question.multiSelect) {
      if (typeof raw !== "string") {
        answer = "";
      } else {
        const selectedLabels = raw
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean)
          .filter((label) =>
            question.options.some((option) => option.label === label),
          );

        answer = selectedLabels.join(", ");
      }
    } else if (
      typeof raw === "string" &&
      question.options.some((option) => option.label === raw)
    ) {
      answer = raw;
    }

    if (question.allowFreeText && freeText) {
      answer = answer ? `${answer}\n${freeText}` : freeText;
    }

    answers[question.question] = answer;
  }

  return {
    behavior: "allow",
    updatedInput: {
      questions: input.questions,
      answers,
    },
  };
}

export function buildAskUserQuestionCardData(
  input: AskUserQuestionInput,
  toolUseID: string,
): AskUserQuestionCardData {
  const body: Array<Record<string, unknown>> = [
    {
      type: "TextBlock",
      text: "Question",
      weight: "bolder",
      size: "medium",
    },
    {
      type: "TextBlock",
      text: "Please answer to continue.",
      wrap: true,
      spacing: "small",
    },
  ];

  for (const [index, question] of input.questions.entries()) {
    body.push(
      {
        type: "TextBlock",
        text: question.header,
        weight: "bolder",
        spacing: "medium",
      },
      {
        type: "TextBlock",
        text: question.question,
        wrap: true,
        spacing: "small",
      },
      {
        type: "Input.ChoiceSet",
        id: getQuestionInputId(index),
        isMultiSelect: question.multiSelect ?? false,
        style: "expanded",
        choices: question.options.map((option) => ({
          title: option.description
            ? `${option.label}: ${option.description}`
            : option.label,
          value: option.label,
        })),
      },
    );

    if (question.allowFreeText) {
      body.push({
        type: "Input.Text",
        id: getFreeTextInputId(index),
        placeholder: "Additional details (optional)",
        isMultiline: true,
      });
    }
  }

  const actions: Array<Record<string, unknown>> = [
    {
      type: "Action.Submit",
      title: "Submit",
      style: "positive",
      data: {
        action: "ask_user_question_submit",
        toolUseID,
      },
    },
  ];

  return { body, actions };
}

export function registerAskUserQuestion(
  toolUseID: string,
  input: AskUserQuestionInput,
  opts?: AskUserQuestionHandlerOptions,
): Promise<PermissionResult> {
  if (pendingUserQuestions.has(toolUseID)) {
    return Promise.reject(
      new Error(`AskUserQuestion request ${toolUseID} already exists`),
    );
  }

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<PermissionResult>((resolve) => {
    const timeout = setTimeout(() => {
      pendingUserQuestions.delete(toolUseID);
      resolve({
        behavior: "deny",
        message: "AskUserQuestion request timed out",
        toolUseID,
      });
    }, timeoutMs);

    pendingUserQuestions.set(toolUseID, {
      resolve,
      timeout,
      input,
    });

    return;
  });
}

export function resolveAskUserQuestion(
  toolUseID: string,
  rawAnswers: Record<string, unknown>,
): boolean {
  const pending = pendingUserQuestions.get(toolUseID);
  if (!pending) return false;

  clearTimeout(pending.timeout);
  pendingUserQuestions.delete(toolUseID);

  pending.resolve({
    ...buildAskUserQuestionResponse(pending.input, rawAnswers),
    toolUseID,
  });

  return true;
}

export function handleAskUserQuestion(
  input: Record<string, unknown>,
  context: {
    toolUseID: string;
    sendCard: (request: PermissionRequest) => Promise<void>;
    timeoutMs?: number;
  },
): Promise<PermissionResult> {
  if (!isAskUserQuestionInput(input)) {
    return Promise.resolve({
      behavior: "deny",
      message: "Invalid AskUserQuestion input",
      toolUseID: context.toolUseID,
    });
  }

  return (async () => {
    await context.sendCard({
      toolName: "AskUserQuestion",
      input,
      toolUseID: context.toolUseID,
    });

    return registerAskUserQuestion(context.toolUseID, input, {
      timeoutMs: context.timeoutMs,
    });
  })();
}

export function clearPendingUserQuestions(): void {
  for (const pending of pendingUserQuestions.values()) {
    clearTimeout(pending.timeout);
  }
  pendingUserQuestions.clear();
}
