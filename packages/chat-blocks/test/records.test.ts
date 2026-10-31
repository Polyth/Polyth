import test from "node:test";
import assert from "node:assert/strict";
import { parseDelimited, parseRecords } from "../src/records.ts";

test("JSON arrays, wrapped arrays, row arrays and primitive lists become records", () => {
  assert.deepEqual(parseRecords("a.json", '[{"x":1},{"x":2}]'), { ok: true, records: [{ x: 1 }, { x: 2 }], total: 2, truncated: false });
  assert.deepEqual(parseRecords("a.json", '{"meta":1,"items":[{"x":1}]}').ok && parseRecords("a.json", '{"meta":1,"items":[{"x":1}]}'), { ok: true, records: [{ x: 1 }], total: 1, truncated: false });
  assert.deepEqual((parseRecords("a.json", '[["name","n"],["a",1]]') as { records: unknown }).records, [{ name: "a", n: 1 }]);
  assert.deepEqual((parseRecords("a.json", "[1,2]") as { records: unknown }).records, [{ value: 1 }, { value: 2 }]);
  assert.deepEqual(parseRecords("a.json", "{bad"), { ok: false, reason: "format" });
  assert.deepEqual(parseRecords("a.json", "[]"), { ok: false, reason: "empty" });
  assert.deepEqual(parseRecords("a.json", "  "), { ok: false, reason: "empty" });
  assert.deepEqual(parseRecords("a.json", '[{"x":1}', true), { ok: false, reason: "too-large" });
});

test("JSON Lines skip bad lines and drop a cut final line", () => {
  const text = '{"a":1}\nnot json\n{"a":2}\n{"a":3';
  assert.deepEqual((parseRecords("x.jsonl", text) as { records: unknown }).records, [{ a: 1 }, { a: 2 }]);
  const cut = parseRecords("x.ndjson", '{"a":1}\n{"a":2}\n{"a"', true);
  assert.deepEqual(cut, { ok: true, records: [{ a: 1 }, { a: 2 }], total: 2, truncated: true });
});

test("CSV handles quotes, embedded delimiters/newlines, BOM, semicolons and TSV", () => {
  const csv = '﻿name,note,price\n"Sony, XM6","say ""hi""\nthere",399\nBose,,379\n';
  assert.deepEqual((parseRecords("p.csv", csv) as { records: unknown }).records, [
    { name: "Sony, XM6", note: 'say "hi"\nthere', price: "399" },
    { name: "Bose", note: "", price: "379" },
  ]);
  assert.deepEqual((parseRecords("p.csv", "a;b\n1;2") as { records: unknown }).records, [{ a: "1", b: "2" }]);
  assert.deepEqual((parseRecords("p.tsv", "a\tb\n1\t2") as { records: unknown }).records, [{ a: "1", b: "2" }]);
  assert.deepEqual(parseDelimited('a,b\n1,"open', ",", false), [["a", "b"]], "a cut quoted row is dropped");
});

test("record count is capped and reported", () => {
  const big = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ i })));
  const result = parseRecords("b.json", big, false, 10);
  assert.equal(result.ok && result.records.length, 10);
  assert.equal(result.ok && result.total, 30);
  assert.equal(result.ok && result.truncated, true);
});
