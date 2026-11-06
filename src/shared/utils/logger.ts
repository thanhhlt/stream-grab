import { isRecord } from './guards';
import { isSensitiveHeaderName, redactText } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogContext = Record<string, unknown>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

export interface LogSink {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface LoggerOptions {
  minLevel?: LogLevel;
  sink?: LogSink;
}

const MAX_DEPTH = 4;

/**
 * Makes a log context safe to print: URLs inside strings are redacted, values
 * under credential-like keys are masked, and Errors become plain objects.
 */
export function sanitizeLogValue(value: unknown, key = '', depth = 0): unknown {
  if (key !== '' && isSensitiveHeaderName(key) && value !== undefined && value !== null) return '***';
  if (typeof value === 'string') return redactText(value);
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message) };
  }
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) return value.map((item) => sanitizeLogValue(item, '', depth + 1));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, sanitizeLogValue(child, childKey, depth + 1)]),
    );
  }
  return value;
}

export function createLogger(scope: string, options: LoggerOptions = {}): Logger {
  const minLevel = options.minLevel ?? (import.meta.env.DEV ? 'debug' : 'info');
  const sink = options.sink ?? console;
  const prefix = `[StreamGrab:${scope}]`;

  const write = (level: LogLevel, message: string, context?: LogContext): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const safeMessage = redactText(message);
    if (context === undefined) sink[level](prefix, safeMessage);
    else sink[level](prefix, safeMessage, sanitizeLogValue(context));
  };

  return {
    debug: (message, context) => {
      write('debug', message, context);
    },
    info: (message, context) => {
      write('info', message, context);
    },
    warn: (message, context) => {
      write('warn', message, context);
    },
    error: (message, context) => {
      write('error', message, context);
    },
  };
}
