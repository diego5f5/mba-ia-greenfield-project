import { buildAttachmentDisposition } from './content-disposition.util';

describe('buildAttachmentDisposition', () => {
  it('keeps a plain ASCII name in both parameters', () => {
    expect(buildAttachmentDisposition('aula.mp4')).toBe(
      `attachment; filename="aula.mp4"; filename*=UTF-8''aula.mp4`,
    );
  });

  it('replaces non-ASCII characters in the fallback and percent-encodes filename*', () => {
    expect(buildAttachmentDisposition('Introdução ao Nest.mp4')).toBe(
      `attachment; filename="Introdu__o ao Nest.mp4"; filename*=UTF-8''Introdu%C3%A7%C3%A3o%20ao%20Nest.mp4`,
    );
  });

  it('replaces quotes and backslashes so the quoted string cannot be broken', () => {
    const header = buildAttachmentDisposition('a"b\\c.mp4');

    expect(header).toContain('filename="a_b_c.mp4"');
    expect(header).toContain(`filename*=UTF-8''a%22b%5Cc.mp4`);
  });

  it("percent-encodes the characters encodeURIComponent leaves ('()*)", () => {
    expect(buildAttachmentDisposition("it's (1)*.mp4")).toContain(
      `filename*=UTF-8''it%27s%20%281%29%2A.mp4`,
    );
  });

  it('never lets control characters or CR/LF through (header injection)', () => {
    const header = buildAttachmentDisposition('a\r\nSet-Cookie: x.mp4');

    expect(header).not.toMatch(/[\r\n]/);
  });
});
