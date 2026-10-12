/** Errors safe to show to clients. Messages never include user data (spec §18). */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const errors = {
  unauthenticated: () => new AppError(401, 'UNAUTHENTICATED', 'Please sign in'),
  forbidden: () => new AppError(403, 'FORBIDDEN', 'Not allowed'),
  csrf: () => new AppError(403, 'CSRF_FAILED', 'Request could not be verified'),
  notFound: () => new AppError(404, 'NOT_FOUND', 'Not found'),
};

/** Postgres unique_violation, optionally on a specific constraint/index. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && (constraint === undefined || e.constraint === constraint);
}
