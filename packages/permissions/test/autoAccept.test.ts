// F18 auto-accept policy: pure nearest-parent resolution (child opt-out wins,
// root default off, cycles bounded) and the explicit-settings store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutoAcceptStore, resolveAutoAccept, type AutoAcceptSetting } from "../src/index.ts";

const chain = (settings: Record<string, AutoAcceptSetting>, parents: Record<string, string>) =>
  (id: string) => resolveAutoAccept(id, (x) => settings[x] ?? "inherit", (x) => parents[x]);

test("resolution: explicit setting wins, inherit walks up, root default is off", () => {
  // root → mid → leaf
  const parents = { leaf: "mid", mid: "root" };

  // nothing set anywhere: off (never a global default)
  assert.equal(chain({}, parents)("leaf"), false);

  // parent on, descendants inherit
  assert.equal(chain({ root: "on" }, parents)("leaf"), true);
  assert.equal(chain({ root: "on" }, parents)("mid"), true);
  assert.equal(chain({ root: "on" }, parents)("root"), true);

  // nearest parent wins: mid off shadows root on for the leaf
  assert.equal(chain({ root: "on", mid: "off" }, parents)("leaf"), false);
  assert.equal(chain({ root: "on", mid: "off" }, parents)("root"), true);

  // child opt-out beats an inherited on
  assert.equal(chain({ root: "on", leaf: "off" }, parents)("leaf"), false);

  // own setting needs no parent at all
  assert.equal(chain({ leaf: "on" }, {})("leaf"), true);
});

test("resolution: parent cycles and unknown parents terminate safely", () => {
  assert.equal(chain({}, { a: "b", b: "a" })("a"), false);
  assert.equal(chain({ b: "on" }, { a: "b", b: "a" })("a"), true);
  assert.equal(chain({}, { a: "ghost" })("a"), false); // parent without settings
});

test("store: persists explicit choices only; inherit removes the record", () => {
  const file = join(mkdtempSync(join(tmpdir(), "polyth-aa-")), "auto-accept.json");
  const s1 = createAutoAcceptStore(file);
  assert.equal(s1.get("s1"), "inherit");

  s1.set("s1", "on");
  s1.set("s2", "off");
  assert.equal(s1.get("s1"), "on");
  assert.equal(s1.get("s2"), "off");

  // survives a reload
  const s2 = createAutoAcceptStore(file);
  assert.equal(s2.get("s1"), "on");
  assert.equal(s2.get("s2"), "off");

  // inherit clears the entry from the file
  s2.set("s1", "inherit");
  assert.equal(s2.get("s1"), "inherit");
  assert.doesNotMatch(readFileSync(file, "utf8"), /s1/);
  const s3 = createAutoAcceptStore(file);
  assert.equal(s3.get("s1"), "inherit");
  assert.equal(s3.get("s2"), "off");
});
