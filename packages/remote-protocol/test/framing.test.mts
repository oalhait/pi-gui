import test from "node:test";
import assert from "node:assert/strict";
import { encodeRecord, JsonlDecoder, RecordTooLargeError } from "../dist/index.js";

const bytes = (text: string) => new TextEncoder().encode(text);

await test("keeps U+2028 and U+2029 inside a record", () => {
  const value = { text: "line\u2028separator\u2029paragraph\nnewline" };
  const decoder = new JsonlDecoder();
  const lines = decoder.push(bytes(encodeRecord(value)));
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), value);
});

await test("joins a record split across chunks, including inside a multi-byte character", () => {
  const encoded = bytes(encodeRecord({ text: "héllo 🌍" }));
  const decoder = new JsonlDecoder();
  const lines: string[] = [];
  for (const byte of encoded) {
    lines.push(...decoder.push(Uint8Array.of(byte)));
  }
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), { text: "héllo 🌍" });
  assert.equal(decoder.bufferedBytes, 0);
});

await test("splits several records in one chunk, accepts CRLF and skips blank lines", () => {
  const decoder = new JsonlDecoder();
  const lines = decoder.push(bytes('{"a":1}\r\n\n{"b":2}\n{"c":'));
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  assert.deepEqual(decoder.push(bytes("3}\n")), ['{"c":3}']);
});

await test("rejects a record larger than the limit and recovers for the next one", () => {
  const decoder = new JsonlDecoder({ maxRecordBytes: 8 });
  assert.throws(() => decoder.push(bytes("0123456789")), RecordTooLargeError);
  assert.deepEqual(decoder.push(bytes("\n{}\n")), ["{}"]);
});
