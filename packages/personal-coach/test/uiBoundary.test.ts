import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const widgetsDir = join(dirname(fileURLToPath(import.meta.url)), "../widgets");

test("Coach widgets do not import app-private UI", () => {
  for (const name of readdirSync(widgetsDir)) {
    if (![".ts", ".tsx"].includes(extname(name))) continue;
    const source = readFileSync(join(widgetsDir, name), "utf8");
    assert.doesNotMatch(source, /apps\/web\/src\//, `${name} imports app-private UI`);
  }
});
