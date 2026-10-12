import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

/**
 * Logs must never contain secrets or sensitive survey/game content (spec §19, §20).
 * Any key matching SENSITIVE_KEY is replaced wholesale; email addresses inside
 * remaining strings are masked.
 */
export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY =
  /^(password|passwd|secret|token|access_?token|refresh_?token|id_?token|authorization|cookie|set-cookie|session|csrf|api_?key|email|text|raw_?text|answer|answers|guess|guesses|response_?text|body|distribution|code|invite_?code)$/i;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const MAX_DEPTH = 8;

export function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.replace(EMAIL, REDACTED);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (value instanceof Error) {
    return { type: value.name, message: scrub(value.message, depth + 1) };
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  // Class instances (e.g. Fastify's raw request/response) are left for pino's serializers,
  // which emit only safe fields (method, url, status) and never headers or bodies.
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrub(v, depth + 1);
  }
  return out;
}

export function createLogger(options: LoggerOptions = {}, destination?: DestinationStream): Logger {
  const config: LoggerOptions = {
    level: process.env.LOG_LEVEL ?? 'info',
    ...options,
    formatters: {
      log: (obj) => scrub(obj) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        // Scrub the message string too (args[0] may be the message when no object is passed).
        const scrubbed = args.map((a) => (typeof a === 'string' ? scrub(a) : a)) as typeof args;
        method.apply(this, scrubbed);
      },
    },
  };
  return destination ? pino(config, destination) : pino(config);
}
