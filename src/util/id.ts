import { randomUUID } from 'crypto';

/** Stable id helper — Node's built-in UUID v4, no external dependency. */
export function newId(): string {
  return randomUUID();
}
