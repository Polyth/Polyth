#!/usr/bin/env node
// Vendored Lucide glyphs: add or check the icon nodes Polyth ships.
//
//   node scripts/icons/lucide.mjs add <PascalOrKebabName...>
//   node scripts/icons/lucide.mjs check
//
// `add` fetches the icon's SVG from the pinned Lucide release, parses its child
// elements into an IconNode and inserts (or updates) the matching export in
// apps/web/src/components/ui/iconNodes.ts, keeping the file sorted by name. It
// then tells you which line to wire into icons.ts. `check` verifies that the
// file is well-formed, sorted, generated from the pinned release, and that
// every node is referenced by icons.ts.
//
// Zero dependencies on purpose: Node built-ins and global fetch only. Lucide is
// ISC licensed; the licence text ships as components/ui/LUCIDE-LICENSE.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** The Lucide release the glyphs are vendored from. Bump it with --version. */
const PINNED_VERSION = "1.61.0";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const nodesPath = path.join(repoRoot, "apps/web/src/components/ui/iconNodes.ts");
const iconsPath = path.join(repoRoot, "apps/web/src/components/ui/icons.ts");
const RAW_ICON_URL = "https://raw.githubusercontent.com/lucide-icons/lucide";

/** Lucide tags are plain release numbers (no leading "v"). */
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

const toKebabCase = (value) =>
  value
    // "Volume2" is the glyph lucide/icons/volume-2.svg; digits start a word.
    .replace(/([A-Za-z])(\d)/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();

const toPascalCase = (value) =>
  value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

const canonicalName = (input) => {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("empty icon name");
  return { kebab: toKebabCase(trimmed), pascal: toPascalCase(toKebabCase(trimmed)) };
};

/** SVG attribute names are kebab-case; React (and Lucide's data) use camelCase. */
const attributeName = (name) => {
  if (name.startsWith("aria-") || name.startsWith("data-")) return name;
  return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
};

const decodeEntities = (value) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const parseAttributes = (source) => {
  const attributes = {};
  for (const match of source.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g)) {
    attributes[attributeName(match[1])] = decodeEntities(match[2]);
  }
  return attributes;
};

/** Parse a Lucide SVG file into its icon node (the SVG's child elements). */
export const parseIconSvg = (svg) => {
  const root = svg.match(/<svg\b[^>]*>([\s\S]*)<\/svg>/);
  if (!root) throw new Error("not an SVG document");
  const body = root[1].replace(/<!--[\s\S]*?-->/g, "").trim();
  const node = [];
  const elementPattern = /<([a-zA-Z][\w:-]*)\b([^>]*?)\/?>/g;
  let consumed = "";
  for (const match of body.matchAll(elementPattern)) {
    consumed += match[0];
    const [, tag, rawAttributes] = match;
    if (tag === "g" || tag === "defs" || tag === "title") {
      throw new Error(`unsupported <${tag}> wrapper in icon SVG`);
    }
    node.push([tag, parseAttributes(rawAttributes)]);
  }
  if (body.replace(/\s+/g, "") !== consumed.replace(/\s+/g, "")) {
    throw new Error("could not parse every child element of the icon SVG");
  }
  if (node.length === 0) throw new Error("icon SVG has no child elements");
  return node;
};

const formatAttributeValue = (value) => JSON.stringify(value);
const formatKey = (key) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key));

/**
 * One export block, formatted exactly like the generated file. Children need a
 * React key (Lucide ships stable hashes; a positional key is just as stable
 * here) so rendering never warns about a keyless list.
 */
const formatEntry = (pascal, node) => {
  const lines = [`export const ${pascal}: IconNode = [`];
  node.forEach(([tag, attributes], index) => {
    const entries = Object.entries(attributes).map(
      ([key, value]) => `${formatKey(key)}: ${formatAttributeValue(value)}`,
    );
    if (!("key" in attributes)) entries.push(`key: ${JSON.stringify(`${tag}-${index}`)}`);
    lines.push(`  ["${tag}", { ${entries.join(", ")} }],`);
  });
  lines.push("];");
  return lines.join("\n");
};

const ENTRY_PATTERN = /^export const ([A-Za-z_$][\w$]*): IconNode = \[\n([\s\S]*?)\n\];$/gm;

const splitGeneratedFile = (source) => {
  const firstEntry = source.indexOf("export const ");
  if (firstEntry < 0) throw new Error("iconNodes.ts has no icon exports");
  const prefix = source.slice(0, firstEntry);
  const entries = new Map();
  for (const match of source.slice(firstEntry).matchAll(ENTRY_PATTERN)) {
    const [, name, body] = match;
    if (entries.has(name)) throw new Error(`duplicate icon export ${name}`);
    const raw = match[0];
    if (!raw.startsWith(`export const ${name}: IconNode = [`)) throw new Error(`malformed entry ${name}`);
    entries.set(name, { name, raw, body });
  }
  return { prefix, entries };
};

const joinGeneratedFile = (prefix, entries) => {
  const sorted = [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return `${prefix}${sorted.map((entry) => `${entry.raw}\n\n`).join("")}`.replace(/\n*$/, "\n");
};

const fetchIconSvg = async (version, kebab) => {
  const url = `${RAW_ICON_URL}/${version}/icons/${kebab}.svg`;
  const response = await fetch(url, { redirect: "follow" });
  if (response.status === 404) {
    throw new Error(`unknown Lucide icon "${kebab}" in release ${version} (${url} answered 404)`);
  }
  if (!response.ok) throw new Error(`could not fetch ${url}: HTTP ${response.status}`);
  return response.text();
};

const addIcons = async (args) => {
  const names = [];
  let version = PINNED_VERSION;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--version") {
      version = args[index + 1] ?? "";
      index += 1;
      if (!versionPattern.test(version)) throw new Error(`--version needs a Lucide release tag, got "${version}"`);
      continue;
    }
    names.push(arg);
  }
  if (names.length === 0) throw new Error("add needs at least one icon name");
  const source = await readFile(nodesPath, "utf8");
  const { prefix, entries } = splitGeneratedFile(source);
  const added = [];
  for (const input of names) {
    const { kebab, pascal } = canonicalName(input);
    const svg = await fetchIconSvg(version, kebab);
    const node = parseIconSvg(svg);
    const action = entries.has(pascal) ? "updated" : "added";
    entries.set(pascal, { name: pascal, raw: formatEntry(pascal, node), body: "" });
    added.push({ pascal, kebab, action });
  }
  const next = joinGeneratedFile(prefix, entries);
  if (next !== source) await writeFile(nodesPath, next);
  for (const { pascal, kebab, action } of added) {
    console.log(`${action} ${pascal} (lucide ${version}, icons/${kebab}.svg)`);
    if (!source.includes(`nodes.${pascal}`)) {
      console.log(`  wire it: const ${pascal} = createIcon("${kebab}", nodes.${pascal}); and add its export alias in icons.ts`);
    }
  }
  console.log(`\napps/web/src/components/ui/iconNodes.ts now holds ${entries.size} icons; run \`node scripts/icons/lucide.mjs check\`.`);
};

const check = async () => {
  const source = await readFile(nodesPath, "utf8");
  const { prefix, entries } = splitGeneratedFile(source);
  const problems = [];

  const pinnedLine = `// Generated by scripts/icons/lucide.mjs from Lucide ${PINNED_VERSION}, ISC licence in`;
  if (!prefix.startsWith(pinnedLine)) {
    problems.push(`header must name the pinned Lucide release ("${pinnedLine}")`);
  }
  if (!prefix.includes('import type { IconNode } from "./iconBase.tsx";')) {
    problems.push("header must import `IconNode` from ./iconBase.tsx");
  }

  const names = [...entries.keys()];
  const sorted = [...names].sort();
  if (names.join("\n") !== sorted.join("\n")) problems.push("entries are not sorted by name");

  for (const entry of entries.values()) {
    const lines = entry.raw.slice(entry.raw.indexOf("[\n") + 2, entry.raw.lastIndexOf("]")).split("\n").filter(Boolean);
    if (lines.length === 0) {
      problems.push(`${entry.name}: node has no children`);
      continue;
    }
    lines.forEach((line, index) => {
      if (!/^  \["[a-z][\w:-]*", \{ .* \}\],$/.test(line)) {
        problems.push(`${entry.name}: malformed child ${index + 1}: ${line.trim()}`);
      } else if (!/\bkey: "/.test(line)) {
        problems.push(`${entry.name}: child ${index + 1} has no React key`);
      }
    });
  }

  const icons = await readFile(iconsPath, "utf8");
  for (const name of names) {
    if (!new RegExp(`nodes\\.${name}\\b`).test(icons)) problems.push(`${name} is not referenced by icons.ts (nodes.${name})`);
  }

  if (problems.length > 0) {
    console.error(`iconNodes.ts is not consistent:\n  - ${problems.join("\n  - ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`iconNodes.ts: ${names.length} icons from Lucide ${PINNED_VERSION}, sorted, well-formed and all used by icons.ts.`);
};

const main = async (argv) => {
  const [command, ...args] = argv;
  if (command === "add") await addIcons(args);
  else if (command === "check") await check();
  else {
    console.error("usage: node scripts/icons/lucide.mjs add <PascalOrKebabName...> [--version <tag>]\n       node scripts/icons/lucide.mjs check");
    process.exitCode = 2;
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`icon sync failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
