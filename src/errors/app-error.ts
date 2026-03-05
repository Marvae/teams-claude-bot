import type { ErrorCode } from "./error-codes.js";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly module: string;

  constructor(
    module: string,
    code: ErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "AppError";
    this.code = code;
    this.module = module;
  }
}
