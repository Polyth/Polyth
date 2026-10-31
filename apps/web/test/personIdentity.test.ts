// A person's colour in chats with people: stable, the same for every reader of
// a chat, never shared inside a chat while tones are left, and in a small chat
// never a near neighbour of another voice.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assignPersonTones, personToneOf, preferredPersonTone, PERSON_TONES } from "../src/personIdentity.ts";

const ids = (count: number, seed: string) => Array.from({ length: count }, (_, index) => `usr_${seed}_${index}`);
const distance = (a: number, b: number) => Math.min(Math.abs(a - b), PERSON_TONES - Math.abs(a - b));

test("a person's preferred tone is stable and in range", () => {
  for (const id of ids(50, "stable")) {
    const tone = preferredPersonTone(id);
    assert.equal(tone, preferredPersonTone(id));
    assert.ok(Number.isInteger(tone) && tone >= 0 && tone < PERSON_TONES);
  }
});

test("the same people get the same tones in any order, and empty ids are ignored", () => {
  const people = ids(6, "order");
  const forward = assignPersonTones(people);
  const backward = assignPersonTones([...people].reverse().concat("", people[0]!));
  assert.deepEqual([...backward.entries()].sort(), [...forward.entries()].sort());
  assert.equal(forward.has(""), false);
});

test("no two people in a chat share a tone while there are tones to spare", () => {
  for (let round = 0; round < 200; round++) {
    for (const size of [2, 3, 5, 8]) {
      const tones = [...assignPersonTones(ids(size, `share${round}`)).values()];
      assert.equal(new Set(tones).size, size, `round ${round}, ${size} people`);
    }
  }
});

test("up to four people are never neighbours on the wheel, and keep their tone from chat to chat", () => {
  for (let round = 0; round < 300; round++) {
    const people = ids(2 + (round % 3), `near${round}`);
    const tones = [...assignPersonTones(people).values()];
    for (const a of tones) for (const b of tones) if (a !== b) assert.ok(distance(a, b) >= 2, `round ${round}: ${tones}`);
  }
  // A person alone with the reader in one chat and among three in another:
  // without a clash they keep one colour.
  const [ann, ines, max] = ["usr_ann_x", "usr_ines_y", "usr_max_z"];
  const pair = assignPersonTones([ann, ines]);
  const group = assignPersonTones([ann, ines, max]);
  if (pair.get(ines) !== pair.get(ann) && group.get(max) !== pair.get(ann)) assert.equal(group.get(ann), pair.get(ann));
});

test("past eight people tones repeat rather than fail; an unknown person falls back to their own", () => {
  const tones = assignPersonTones(ids(12, "many"));
  assert.equal(tones.size, 12);
  for (const tone of tones.values()) assert.ok(tone >= 0 && tone < PERSON_TONES);
  assert.equal(personToneOf(tones, "usr_stranger"), preferredPersonTone("usr_stranger"));
  assert.equal(personToneOf(tones, null), null);
});

test("every tone has a colour in the stylesheet, from the theme's own signal colours", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  for (let tone = 0; tone < PERSON_TONES; tone++) {
    const rule = css.match(new RegExp(`\\[data-person-tone="${tone}"\\] \\{ --person-tone: ([^;]+); \\}`));
    assert.ok(rule, `tone ${tone} has a rule`);
    assert.match(rule![1]!, /^(var\(--(red|amber|green|blue|purple)\)|color-mix\(in oklab, var\(--\w+\) \d+%, var\(--\w+\)\))$/);
  }
});
