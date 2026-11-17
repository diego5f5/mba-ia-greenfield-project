/** Characters outside printable ASCII, plus the ones that break a quoted string. */
const UNSAFE_ASCII_FALLBACK = /[^\x20-\x7E]|["\\]/g;

/** RFC 5987 `attr-char` excludes these, but `encodeURIComponent` leaves them. */
const RFC_5987_EXTRA_ENCODED = /['()*]/g;

/**
 * `Content-Disposition` value that forces a download and keeps the original
 * file name: an ASCII fallback in `filename` for old clients and the exact
 * UTF-8 name in `filename*` (RFC 6266 / RFC 5987).
 */
export function buildAttachmentDisposition(fileName: string): string {
  const asciiFallback = fileName.replace(UNSAFE_ASCII_FALLBACK, '_');
  const encoded = encodeURIComponent(fileName).replace(
    RFC_5987_EXTRA_ENCODED,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
