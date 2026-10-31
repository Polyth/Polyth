// Conformance fixtures for the ```ui format: `fixtures/<name>.ui` is a fence
// body (one trailing newline ignored), `fixtures/<name>.json` the parse it
// must give. A format change shows up as a reviewed fixture diff; regenerate
// with UPDATE_CHAT_BLOCK_FIXTURES=1 and read the diff before committing.
//
// Every fixture also streams: each prefix, cut at any character, parses
// without throwing; a finished row never changes once the next line has
// begun; and the stream converges on the closed parse.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseChatBlock, type ParseResult } from "../src/parse.ts";

const dir = new URL("./fixtures/", import.meta.url);
const names = readdirSync(dir).filter((file) => file.endsWith(".ui")).map((file) => file.slice(0, -3)).sort();
const update = process.env.UPDATE_CHAT_BLOCK_FIXTURES === "1";

const body = (name: string): string => readFileSync(new URL(`${name}.ui`, dir), "utf8").replace(/\n$/, "");
/** The stored shape: the parse without the streaming flag, as plain JSON. */
const snapshot = (result: ParseResult): unknown => {
  if (!result.ok) return result;
  const { pending: _pending, ...doc } = result.doc;
  return JSON.parse(JSON.stringify(doc));
};

test("there are fixtures for every view and for the failure modes", () => {
  assert.ok(names.length >= 12, `found ${names.length}`);
});

for (const name of names) {
  test(`fixture ${name}: closed parse`, () => {
    const actual = snapshot(parseChatBlock(body(name), true));
    const expectedUrl = new URL(`${name}.json`, dir);
    if (update) writeFileSync(expectedUrl, `${JSON.stringify(actual, null, 2)}\n`);
    assert.deepEqual(actual, JSON.parse(readFileSync(expectedUrl, "utf8")));
  });

  test(`fixture ${name}: streaming`, () => {
    const text = body(name);
    const final = parseChatBlock(text, true);
    for (let end = 0; end <= text.length; end++) {
      assert.doesNotThrow(() => parseChatBlock(text.slice(0, end), false), `prefix of ${end} characters`);
    }
    // The closing marker arriving after a newline settles exactly the closed parse.
    assert.deepEqual(snapshot(parseChatBlock(`${text}\n`, false)), snapshot(final));
    if (!final.ok) return;
    // At each line boundary the rows already shown are the final rows.
    const lines = text.split("\n");
    let shown = 0;
    for (let k = 1; k < lines.length; k++) {
      const partial = parseChatBlock(`${lines.slice(0, k).join("\n")}\n${lines[k]!.slice(0, 1)}`, false);
      if (!partial.ok) continue;
      assert.equal(partial.doc.pending, true);
      assert.ok(partial.doc.items.length >= shown, `rows never disappear (line ${k + 1})`);
      shown = partial.doc.items.length;
      partial.doc.items.forEach((item, i) => {
        assert.deepEqual(item, final.doc.items[i], `row ${i + 1} is final once line ${k + 1} has begun`);
      });
    }
  });
}
