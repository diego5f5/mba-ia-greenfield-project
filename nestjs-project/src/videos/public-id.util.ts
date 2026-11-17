import { randomBytes } from 'node:crypto';

/**
 * URL-facing video identifier (phase-03-videos/TD-09): 8 random bytes encoded
 * as base64url are exactly 11 characters from `[A-Za-z0-9_-]`. Uniqueness is
 * enforced by the database; callers retry on a unique violation.
 */
export function generatePublicId(): string {
  return randomBytes(8).toString('base64url');
}
