import { QueryFailedError } from 'typeorm';
import { isPgUniqueViolationOnColumn } from './pg-errors.util';

function queryError(code: string, detail: string): QueryFailedError {
  return new QueryFailedError(
    'INSERT',
    [],
    Object.assign(new Error('driver error'), { code, detail }),
  );
}

describe('isPgUniqueViolationOnColumn', () => {
  it('is true for a unique violation that mentions the column', () => {
    const error = queryError('23505', 'Key (public_id)=(abc) already exists.');

    expect(isPgUniqueViolationOnColumn(error, 'public_id')).toBe(true);
  });

  it('is false for a unique violation on another column', () => {
    const error = queryError('23505', 'Key (nickname)=(abc) already exists.');

    expect(isPgUniqueViolationOnColumn(error, 'public_id')).toBe(false);
  });

  it('is false for a different SQLSTATE', () => {
    const error = queryError('23503', 'Key (public_id)=(abc) is not present.');

    expect(isPgUniqueViolationOnColumn(error, 'public_id')).toBe(false);
  });

  it('is false for errors that are not QueryFailedError', () => {
    expect(isPgUniqueViolationOnColumn(new Error('boom'), 'public_id')).toBe(
      false,
    );
    expect(isPgUniqueViolationOnColumn(undefined, 'public_id')).toBe(false);
  });
});
