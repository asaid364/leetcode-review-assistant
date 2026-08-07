export class AppError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export function asAppError(error, fallbackCode = "UNKNOWN_ERROR") {
  if (error instanceof AppError) {
    return error;
  }

  return new AppError(
    fallbackCode,
    error instanceof Error ? error.message : "发生未知错误",
    error?.details && typeof error.details === "object" ? error.details : {},
    error instanceof Error ? error : undefined,
  );
}

export function serializeError(error) {
  const appError = asAppError(error);
  return {
    code: appError.code,
    message: redact(appError.message),
    details: redactValue(appError.details),
  };
}

function redact(value) {
  return String(value ?? "")
    .replace(/(password|passwd|cookie|csrf|token|authorization|session)[^\s,;]*/gi, "$1=[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[REDACTED]");
}

function redactValue(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (/password|passwd|cookie|csrf|token|authorization|session/i.test(key)) {
      return [key, "[REDACTED]"];
    }
    return [key, redactValue(entry)];
  }));
}
