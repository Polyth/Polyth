import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "release", "coverage",
  ".next", ".turbo", ".cache", "target", "vendor"
]);
const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".html"]);
const CSS_EXTS = new Set([".css"]);
const ALL_EXTS = new Set([...SOURCE_EXTS, ...CSS_EXTS]);

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
      continue;
    }
    if (ALL_EXTS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, "/");
}

function stripCssComments(input) {
  return input.replace(/\/\*[\s\S]*?\*\//g, "");
}

function normalizeSpace(input) {
  return input.replace(/\s+/g, " ").trim();
}

function declarationSignature(body) {
  const decls = [];
  for (const raw of body.split(";")) {
    const idx = raw.indexOf(":");
    if (idx <= 0) continue;
    const prop = normalizeSpace(raw.slice(0, idx)).toLowerCase();
    const value = normalizeSpace(raw.slice(idx + 1));
    if (!prop || !value || prop.startsWith("@")) continue;
    decls.push(prop + ":" + value);
  }
  if (decls.length < 3) return null;
  return decls.sort().join(";");
}

function escapeRegExp(input) {
  return input.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
}

const files = await walk(ROOT);
const contents = new Map();
for (const file of files) contents.set(file, await readFile(file, "utf8"));

const cssFiles = files.filter((f) => CSS_EXTS.has(path.extname(f)));
const sourceFiles = files.filter((f) => SOURCE_EXTS.has(path.extname(f)));

const largest = [];
for (const file of files) {
  const s = await stat(file);
  const text = contents.get(file);
  largest.push({ file: rel(file), bytes: s.size, lines: text.split("\n").length });
}
largest.sort((a, b) => b.bytes - a.bytes);

const selectorDefs = new Map();
const blockDefs = new Map();
const classDefs = new Map();

for (const file of cssFiles) {
  const css = stripCssComments(contents.get(file));
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = ruleRe.exec(css))) {
    const selectorText = normalizeSpace(match[1]);
    const body = match[2];
    if (!selectorText || selectorText.startsWith("@")) continue;

    for (const selector of selectorText.split(",").map(normalizeSpace).filter(Boolean)) {
      const list = selectorDefs.get(selector) ?? [];
      list.push(rel(file));
      selectorDefs.set(selector, list);

      for (const classMatch of selector.matchAll(/\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g)) {
        const name = classMatch[1];
        const defs = classDefs.get(name) ?? new Set();
        defs.add(rel(file));
        classDefs.set(name, defs);
      }
    }

    const sig = declarationSignature(body);
    if (sig) {
      const list = blockDefs.get(sig) ?? [];
      list.push({ file: rel(file), selector: selectorText });
      blockDefs.set(sig, list);
    }
  }
}

const sourceCorpus = sourceFiles.map((f) => contents.get(f)).join("\n");
const likelyUnusedClasses = [];
for (const [name, defFiles] of classDefs) {
  const escaped = escapeRegExp(name);
  const re = new RegExp("(^|[^A-Za-z0-9_-])" + escaped + "([^A-Za-z0-9_-]|$)", "g");
  const matches = sourceCorpus.match(re);
  const refs = matches?.length ?? 0;
  if (refs === 0) likelyUnusedClasses.push({ className: name, files: [...defFiles] });
}
likelyUnusedClasses.sort((a, b) => a.className.localeCompare(b.className));

const duplicateSelectors = [...selectorDefs.entries()]
  .filter(([, locations]) => locations.length > 1)
  .map(([selector, locations]) => ({ selector, definitions: locations.length, files: [...new Set(locations)] }))
  .sort((a, b) => b.definitions - a.definitions);

const duplicateBlocks = [...blockDefs.entries()]
  .filter(([, locations]) => locations.length > 1)
  .map(([signature, locations]) => ({ signature, definitions: locations.length, locations }))
  .sort((a, b) => b.definitions - a.definitions);

const report = {
  summary: {
    sourceFiles: sourceFiles.length,
    cssFiles: cssFiles.length,
    cssBytes: cssFiles.reduce((sum, f) => sum + Buffer.byteLength(contents.get(f)), 0),
    duplicateSelectorCandidates: duplicateSelectors.length,
    duplicateDeclarationBlockCandidates: duplicateBlocks.length,
    likelyUnusedCssClasses: likelyUnusedClasses.length,
  },
  largestFiles: largest.slice(0, 40),
  duplicateSelectors: duplicateSelectors.slice(0, 120),
  duplicateDeclarationBlocks: duplicateBlocks.slice(0, 80),
  likelyUnusedCssClasses: likelyUnusedClasses.slice(0, 250),
};

console.log("REPO_CLEANUP_AUDIT_BEGIN");
console.log(JSON.stringify(report, null, 2));
console.log("REPO_CLEANUP_AUDIT_END");
