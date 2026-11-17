import { generatePublicId } from './public-id.util';

describe('generatePublicId', () => {
  it('returns 11 characters from the base64url alphabet', () => {
    for (let i = 0; i < 50; i++) {
      expect(generatePublicId()).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
  });

  it('returns distinct values on successive calls', () => {
    const ids = new Set(Array.from({ length: 200 }, () => generatePublicId()));

    expect(ids.size).toBe(200);
  });
});
