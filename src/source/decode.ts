import zlib from "node:zlib";

/** zlib stream header byte. See docs/api-notes.md section 1. */
const ZLIB_MAGIC = 0x78;

/**
 * Turn an upstream response body into JSON.
 *
 * The transport is doubly compressed. `content-encoding: br` is stripped by fetch,
 * but the body underneath is a zlib stream that has been latin-1 -> UTF-8 re-encoded:
 * each byte of the stream arrives as a Unicode codepoint, so the raw bytes read
 * `78 c2 9c ...` rather than the `78 9c` zlib header. Reading the body as text and
 * mapping codepoints back down to bytes recovers the real stream. Every codepoint in
 * the mojibake body is <= 0xFF, so the round-trip is lossless.
 *
 * A handful of endpoints may serve plain JSON, so the zlib header is sniffed rather
 * than assumed and a non-inflatable body falls back to being read as text.
 */
export function decodeBody(text: string): unknown {
  const bytes = Buffer.from(text, "latin1");

  let json: string;
  if (bytes[0] === ZLIB_MAGIC) {
    try {
      json = zlib.inflateSync(bytes).toString("utf8");
    } catch {
      // Sniffed as zlib but did not inflate - treat as plain text rather than throwing.
      json = text;
    }
  } else {
    json = text;
  }

  return JSON.parse(json);
}
