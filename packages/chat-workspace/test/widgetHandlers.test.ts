import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const WIDGET_DIRS = [
  join(import.meta.dirname, "../widgets"),
  join(import.meta.dirname, "../../handoff/widgets"),
];

function openingTagHasHandler(tag: string): boolean {
  return /onClick\s*=/.test(tag)
    || /type\s*=\s*["']submit["']/.test(tag)
    || /\{\s*\.\.\./.test(tag);
}

function findInertButtons(source: string, file: string): string[] {
  const violations: string[] = [];
  const re = /<(Button|button)\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const start = match.index;
    let depth = 0;
    let i = start;
    let tag = "";
    while (i < source.length) {
      const ch = source[i]!;
      tag += ch;
      if (ch === "{") depth += 1;
      if (ch === "}") depth -= 1;
      if (ch === ">" && depth === 0) break;
      i += 1;
    }
    if (!openingTagHasHandler(tag)) {
      const line = source.slice(0, start).split("\n").length;
      violations.push(`${file}:${line} ${tag.replace(/\s+/g, " ").slice(0, 100)}`);
    }
  }
  return violations;
}

async function collectTsxFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".tsx")) continue;
    const parent = entry.parentPath ?? (entry as { path?: string }).path ?? dir;
    files.push(join(parent, entry.name));
  }
  return files;
}

test("chat-workspace web entry installer does not call React hooks", async () => {
  const source = await readFile(join(import.meta.dirname, "../widgets/index.tsx"), "utf8");
  const installer = source.slice(source.indexOf("defineWebPackage"));
  assert.doesNotMatch(
    installer,
    /\buse(Ref|State|Effect|ImperativeHandle|Memo|Callback)\s*\(/,
    "defineWebPackage installer runs outside React; hooks throw Minified React error #321 and the package never activates",
  );
});

test("chat-workspace and handoff widget buttons declare handlers", async () => {
  const violations: string[] = [];
  for (const dir of WIDGET_DIRS) {
    const files = await collectTsxFiles(dir);
    for (const file of files) {
      const source = await readFile(file, "utf8");
      violations.push(...findInertButtons(source, file));
    }
  }
  assert.deepEqual(violations, []);
});
