import { z } from 'zod';
import { AppError } from './errors.js';

/** Parses input with a strict schema. Unknown fields are rejected (mass-assignment protection). */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((i) => i.path.join('.') || '(body)'))];
    // Only field names are returned — never the submitted values.
    throw new AppError(400, 'VALIDATION_FAILED', 'Some fields are invalid', { fields });
  }
  return result.data;
}
