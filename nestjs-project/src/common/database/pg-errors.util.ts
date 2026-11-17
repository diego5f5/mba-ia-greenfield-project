import { QueryFailedError } from 'typeorm';

const PG_UNIQUE_VIOLATION = '23505';

/**
 * True when `error` is a PostgreSQL unique-constraint violation whose detail
 * mentions `column` (pg attaches `code` and `detail` to the driver error that
 * TypeORM wraps in a `QueryFailedError`).
 */
export function isPgUniqueViolationOnColumn(
  error: unknown,
  column: string,
): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const { code, detail } = error.driverError as {
    code?: unknown;
    detail?: unknown;
  };
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(column)
  );
}
