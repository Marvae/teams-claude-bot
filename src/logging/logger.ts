type LogValue = string | number | boolean | null | undefined;

export type LogContext = Record<string, LogValue>;

function formatValue(value: LogValue): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") {
    const singleLine = value.replace(/[\r\n]+/g, " ").trim();
    return singleLine.length > 200
      ? `${singleLine.slice(0, 197)}...`
      : singleLine;
  }
  return String(value);
}

function formatContext(context?: LogContext): string {
  if (!context) return "";
  const entries = Object.entries(context).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}=${formatValue(v)}`).join(", ");
}

export function sanitizeCommandName(command?: string): string | undefined {
  if (!command) return undefined;
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  const token = trimmed.split(/\s+/)[0];
  return token.length > 100 ? `${token.slice(0, 97)}...` : token;
}

function line(module: string, action: string, context?: LogContext): string {
  const formattedContext = formatContext(context);
  return formattedContext
    ? `[${module}] ${action}: ${formattedContext}`
    : `[${module}] ${action}`;
}

export function logInfo(module: string, action: string, context?: LogContext): void {
  console.log(line(module, action, context));
}

export function logWarn(module: string, action: string, context?: LogContext): void {
  console.log(line(module, action, context));
}

export function logError(
  module: string,
  action: string,
  error: unknown,
  context?: LogContext,
): void {
  const err = toError(error);
  const errorCode =
    typeof (err as { code?: unknown }).code === "string"
      ? ((err as { code: string }).code ?? undefined)
      : undefined;
  const details: LogContext = {
    ...context,
    errorType: err.name,
    errorCode,
  };
  console.error(line(module, action, details));
  if (err.stack) {
    console.error(`[${module}] stack: ${err.stack}`);
  }
}

export function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}
