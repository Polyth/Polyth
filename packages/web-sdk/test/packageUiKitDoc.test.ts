// Drift guard for the package UI kit reference: docs/dev/package-ui-kit.md
// lists which `host.ui.components` parts are promised by every host (core) and
// which are optional for older hosts. The list and the split must match
// `WebPackageHost["ui"]["components"]` exactly, or an author reads a promise
// the contract no longer makes (or misses a new part).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const DOC = new URL("../../../docs/dev/package-ui-kit.md", import.meta.url);
const CONTRACT = new URL("../src/index.ts", import.meta.url);

interface ContractPart {
  name: string;
  optional: boolean;
}

/** The `components: Readonly<{ … }>` block of `WebPackageHost["ui"]`. */
function contractParts(): ContractPart[] {
  const source = readFileSync(CONTRACT, "utf8");
  const start = source.indexOf("components: Readonly<{");
  assert.notEqual(start, -1, "WebPackageHost ui.components block not found in packages/web-sdk/src/index.ts");
  const parts: ContractPart[] = [];
  const unrecognised: string[] = [];
  let closed = false;
  for (const line of source.slice(start).split("\n").slice(1)) {
    // The block closes at four-space `}>;`; fields are six-space indented, and
    // an optional part's type may itself contain `}>;` on the same line.
    if (/^ {4}\}>;/.test(line)) {
      closed = true;
      break;
    }
    const declaration = /^ {6}(\w+)(\??):\s*(.*)$/.exec(line);
    if (!declaration) continue;
    const [, name, marker, type] = declaration;
    // Optional is either the `?` marker or a `| undefined` union; any other
    // shape must fail loudly instead of hiding a part from the comparison.
    const shape = /^WebUiComponent<(.+)>(\s*\|\s*undefined)?;?$/.exec(type!.trim());
    if (!shape) {
      unrecognised.push(line.trim());
      continue;
    }
    parts.push({ name: name!, optional: marker === "?" || Boolean(shape[2]) });
  }
  assert.ok(closed, "WebPackageHost ui.components block has no closing `}>;`");
  assert.deepEqual(
    unrecognised,
    [],
    "unrecognised field shape in WebPackageHost ui.components; teach this parser about it " +
      "(a part it cannot read is a part the document is never checked against)",
  );
  assert.ok(parts.length > 0, "no component fields parsed from the contract");
  assert.equal(new Set(parts.map((part) => part.name)).size, parts.length, "duplicate component field in the contract");
  return parts;
}

/** A `- **Core parts …**: `A`, `B`.` bullet, including its continuation lines. */
function documentedList(heading: "core" | "optional"): string[] {
  const lines = readFileSync(DOC, "utf8").split("\n");
  const marker = heading === "core" ? /^- \*\*Core parts\b/ : /^- \*\*Optional parts\b/;
  const start = lines.findIndex((line) => marker.test(line));
  assert.notEqual(start, -1, `the "${heading} parts" list is missing from docs/dev/package-ui-kit.md`);
  const bullet: string[] = [lines[start]!];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^- /.test(line)) break;
    bullet.push(line);
  }
  const text = bullet.join(" ");
  const names = [...text.matchAll(/`([A-Z][A-Za-z0-9]*)`/g)].map((match) => match[1]!);
  // The bullet also names non-component members (ui.tabIds, ui.confirm).
  const componentish = names.filter((name) => /^[A-Z]/.test(name));
  assert.ok(componentish.length > 0, `the "${heading} parts" list has no component names`);
  return componentish;
}

function compare(kind: "core" | "optional", contract: string[], documented: string[]): void {
  const expected = new Set(contract);
  const actual = new Set(documented);
  const duplicates = documented.filter((name, index) => documented.indexOf(name) !== index);
  assert.deepEqual(duplicates, [], `docs/dev/package-ui-kit.md lists these ${kind} parts twice`);

  const undocumented = [...expected].filter((name) => !actual.has(name)).sort();
  assert.deepEqual(
    undocumented,
    [],
    `WebPackageHost["ui"]["components"] has ${kind} parts ${JSON.stringify(undocumented)} ` +
      `that docs/dev/package-ui-kit.md does not list as ${kind}`,
  );
  const stale = [...actual].filter((name) => !expected.has(name)).sort();
  assert.deepEqual(
    stale,
    [],
    `docs/dev/package-ui-kit.md lists ${JSON.stringify(stale)} as ${kind}, ` +
      `but WebPackageHost["ui"]["components"] has no such ${kind} part`,
  );
}

test("the package UI kit lists exactly the contract's core and optional parts", () => {
  const parts = contractParts();
  const core = parts.filter((part) => !part.optional).map((part) => part.name);
  const optional = parts.filter((part) => part.optional).map((part) => part.name);

  compare("core", core, documentedList("core"));
  compare("optional", optional, documentedList("optional"));

  // A name in both bullets would make the split meaningless.
  const overlap = documentedList("core").filter((name) => documentedList("optional").includes(name));
  assert.deepEqual(overlap, [], "docs/dev/package-ui-kit.md lists the same part as both core and optional");
});
