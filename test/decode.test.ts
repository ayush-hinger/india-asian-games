import assert from "node:assert/strict";
import { test } from "node:test";
import zlib from "node:zlib";
import { decodeBody } from "../src/source/decode.ts";

/**
 * Reproduce what the upstream actually puts on the wire: a zlib stream whose bytes
 * have each been widened into a Unicode codepoint. `res.text()` UTF-8-decodes that
 * back into exactly this string, which is what decodeBody receives.
 */
function asUpstreamWouldSend(value: unknown): string {
  return zlib.deflateSync(Buffer.from(JSON.stringify(value), "utf8")).toString("latin1");
}

test("inflates the mojibake-wrapped zlib body", () => {
  const payload = { Disc: "SHO", Orgs: ["IND", "CHN"], Rk: "1" };
  assert.deepEqual(decodeBody(asUpstreamWouldSend(payload)), payload);
});

test("round-trips a large array without truncation", () => {
  const payload = Array.from({ length: 500 }, (_, i) => ({ ResCode: `UNIT-${i}`, Orgs: ["IND"] }));
  assert.deepEqual(decodeBody(asUpstreamWouldSend(payload)), payload);
});

test("preserves non-ASCII text through the latin1 round-trip", () => {
  // Athlete and venue names carry accents; a broken round-trip corrupts them silently.
  const payload = { name: "MÜLLER Jörg", venue: "Gifu Prefectural Green Stadium", jp: "愛知" };
  assert.deepEqual(decodeBody(asUpstreamWouldSend(payload)), payload);
});

test("the first bytes on the wire are the documented mojibake signature", () => {
  const wire = asUpstreamWouldSend({ a: 1 });
  const rawBytes = Buffer.from(wire, "utf8");
  // What a naive Buffer.from(arrayBuffer) decoder would see - and choke on.
  assert.equal(rawBytes[0], 0x78);
  assert.equal(rawBytes[1], 0xc2);
  assert.equal(rawBytes[2], 0x9c);
  // The recovered stream carries the real zlib header instead.
  const recovered = Buffer.from(wire, "latin1");
  assert.equal(recovered[0], 0x78);
  assert.equal(recovered[1], 0x9c);
});

test("the brief's original decoder is what this replaces", () => {
  // Guards the finding in docs/api-notes.md: treating the body as raw bytes fails.
  const wire = asUpstreamWouldSend({ a: 1 });
  assert.throws(() => zlib.inflateSync(Buffer.from(wire, "utf8")));
});

test("passes through a body that is already plain JSON", () => {
  assert.deepEqual(decodeBody('{"ok":true}'), { ok: true });
});

test("falls back to text when a zlib-looking body does not inflate", () => {
  // Starts with 'x' (0x78) but is not compressed - must not throw on the sniff.
  assert.deepEqual(decodeBody('"xyz"'), "xyz");
});

test("throws on genuinely unparseable input", () => {
  assert.throws(() => decodeBody("not json at all"));
});
