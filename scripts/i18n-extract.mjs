#!/usr/bin/env node
/**
 * Mechanical i18n extractor for the Polyth web UI.
 *
 * It only rewrites syntax positions known to surface copy: JSX text and
 * accessibility attributes, display metadata, and browser/UI feedback calls.
 * Re-running it is safe because existing tr() calls are left untouched.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(root, "apps/web/src");
const englishPath = path.join(sourceRoot, "i18n/locales/en.ts");
const write = process.argv.includes("--write");

const VISIBLE_ATTRIBUTES = new Set([
  "aria-label", "aria-description", "title", "placeholder", "alt", "data-label",
  "label", "description", "hint", "blurb", "caption", "heading", "tooltip",
  "emptyText", "confirmText", "body", "actionLabel", "meta",
  // Custom component props use camelCase rather than DOM attribute spelling.
  "ariaLabel", "ariaDescription", "sheetTitle",
]);
const VISIBLE_PROPERTIES = new Set([
  "label", "title", "description", "hint", "blurb", "body", "highlight",
  "placeholder", "caption", "heading", "tooltip", "plainDescription",
]);
const FEEDBACK_CALLS = new Set([
  "alert", "confirm", "prompt", "announce", "setError", "setNotice",
  "setMessage", "setStatusText", "setFeedback",
]);
const COMMON_MESSAGES = new Set([
  "Active", "Add", "Apply", "Archive", "Back", "Cancel", "Close", "Continue",
  "Copy", "Create", "Delete", "Done", "Edit", "Error", "Loading…", "Manage",
  "More", "New", "Next", "No", "None", "Open", "Pause", "Refresh", "Reload",
  "Remove", "Rename", "Reset", "Restore", "Resume", "Retry", "Run", "Save",
  "Saved", "Saving…", "Search", "Select", "Settings", "Skip", "Start", "Stop",
  "Submit", "Unavailable", "Update", "Yes",
]);

const humanText = (value) => {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || !/[A-Za-zÀ-ÿ\u0400-\u04ff\u0600-\u06ff\u4e00-\u9fff]/.test(text)) return false;
  if (/^(?:https?:|\/|\.\/|\.\.\/|#(?:[0-9a-f]{3}){1,2}$|var\(|rgb|hsl)/i.test(text)) return false;
  if (/^(?:\[[^\]]+\]|[a-z][\w-]*\[[^\]]+\]|Arrow(?:Up|Down|Left|Right)|Escape|Enter|Tab)$/i.test(text)) return false;
  if (/^[a-z][\w.-]*(?:\/[\w.@-]+)+$/.test(text)) return false;
  if (/^[\w.-]+\/[\w./@-]+$/.test(text)) return false;
  if (/^[a-z][a-z0-9]*(?:[-_.:/][a-z0-9]+)+$/.test(text)) return false;
  if (/^[A-Z_][A-Z0-9_]*$/.test(text) && text.length > 3) return false;
  return true;
};

const normalize = (value) => value.replace(/\s+/g, " ").trim();
const words = (value) => normalize(value)
  .replace(/\{[^}]+\}/g, " value ")
  .replace(/[^A-Za-z0-9]+/g, " ")
  .trim()
  .split(/\s+/)
  .filter(Boolean)
  .slice(0, 7);
const camel = (parts) => parts.map((word, index) => {
  const lower = word.toLowerCase();
  return index === 0 ? lower : lower[0]?.toUpperCase() + lower.slice(1);
}).join("") || "message";
const domainFor = (file) => {
  const rel = path.relative(sourceRoot, file).replace(/\\/g, "/").replace(/\.(?:tsx?|jsx?)$/, "");
  const parts = rel.split("/").filter((part) => !["components", "src"].includes(part));
  return parts.map((part) => camel(part.split(/[^A-Za-z0-9]+/))).join(".");
};
const relativeImport = (file) => {
  let rel = path.relative(path.dirname(file), path.join(sourceRoot, "i18n/index.ts")).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
};
const propertyName = (name) => {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return "";
};
const calleeName = (expression) => {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return "";
};
const isImportLiteral = (node) =>
  ts.isStringLiteral(node) && (
    ts.isImportDeclaration(node.parent)
    || ts.isExportDeclaration(node.parent)
    || ts.isExternalModuleReference(node.parent)
  );

async function sourceFiles(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "i18n") out.push(...await sourceFiles(target));
    } else if (/\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(target);
    }
  }
  return out.sort();
}

const existingEnglish = await readFile(englishPath, "utf8");
const existingEntries = new Map();
for (const match of existingEnglish.matchAll(/^\s*"([^"]+)":\s*("(?:[^"\\]|\\.)*"),?$/gm)) {
  existingEntries.set(match[1], JSON.parse(match[2]));
}
const entries = new Map(existingEntries);
const usedKeys = new Set(entries.keys());

function allocateKey(domain, message) {
  const common = COMMON_MESSAGES.has(message);
  const base = `${common ? "common" : domain}.${camel(words(message))}`;
  let key = base;
  let suffix = 2;
  while (usedKeys.has(key) && entries.get(key) !== message) key = `${base}${suffix++}`;
  usedKeys.add(key);
  entries.set(key, message);
  return key;
}

function templateDetails(node, sf) {
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    return { message: normalize(node.text), params: [] };
  }
  if (!ts.isTemplateExpression(node)) return null;
  let message = node.head.text;
  const params = [];
  const names = new Set();
  for (const span of node.templateSpans) {
    const expression = span.expression.getText(sf);
    const raw = ts.isIdentifier(span.expression)
      ? span.expression.text
      : ts.isPropertyAccessExpression(span.expression)
        ? span.expression.name.text
        : "value";
    let name = raw.replace(/\W+/g, "") || "value";
    let suffix = 2;
    while (names.has(name)) name = `${raw}${suffix++}`;
    names.add(name);
    params.push({ name, expression });
    message += `{${name}}${span.literal.text}`;
  }
  return { message: normalize(message), params };
}

const replacementFor = (node, sf, domain, jsxAttribute = false, jsxText = false) => {
  let detail;
  if (ts.isStringLiteral(node)) detail = { message: normalize(node.text), params: [] };
  else if (ts.isJsxText(node)) detail = { message: normalize(node.getText(sf)), params: [] };
  else detail = templateDetails(node, sf);
  if (!detail || !humanText(detail.message.replace(/\{[^}]+\}/g, ""))) return null;
  const key = allocateKey(domain, detail.message);
  const args = detail.params.length
    ? `, { ${detail.params.map(({ name, expression }) => `${name}: ${expression}`).join(", ")} }`
    : "";
  const call = `tr(${JSON.stringify(key)}${args})`;
  if (jsxAttribute) return `{${call}}`;
  if (jsxText) {
    const raw = node.getText(sf);
    const before = !raw.includes("\n") && /^\s/.test(raw) ? `{" "}` : "";
    const after = !raw.includes("\n") && /\s$/.test(raw) ? `{" "}` : "";
    return `${before}{${call}}${after}`;
  }
  return call;
};

const files = await sourceFiles(sourceRoot);
let changedFiles = 0;
let replacementsMade = 0;

for (const file of files) {
  const source = await readFile(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const domain = domainFor(file);
  const replacements = [];
  const covered = new Set();

  const add = (node, text) => {
    if (!text || covered.has(node.pos)) return;
    replacements.push({ start: node.getStart(sf), end: node.end, text });
    covered.add(node.pos);
  };
  const translateExpressionResult = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      add(node, replacementFor(node, sf, domain));
      return;
    }
    if (ts.isParenthesizedExpression(node)) translateExpressionResult(node.expression);
    else if (ts.isConditionalExpression(node)) {
      translateExpressionResult(node.whenTrue);
      translateExpressionResult(node.whenFalse);
    }
  };
  const visit = (node) => {
    if (ts.isJsxText(node) && humanText(node.getText(sf))) {
      add(node, replacementFor(node, sf, domain, false, true));
      return;
    }
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      if (VISIBLE_ATTRIBUTES.has(name) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) {
          add(node.initializer, replacementFor(node.initializer, sf, domain, true));
          return;
        }
        if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          translateExpressionResult(node.initializer.expression);
        }
      }
    }
    if (ts.isJsxExpression(node) && node.expression && ts.isJsxElement(node.parent)) {
      translateExpressionResult(node.expression);
    }
    if (ts.isPropertyAssignment(node) && VISIBLE_PROPERTIES.has(propertyName(node.name))) {
      translateExpressionResult(node.initializer);
    }
    if (ts.isCallExpression(node) && FEEDBACK_CALLS.has(calleeName(node.expression)) && node.arguments[0]) {
      translateExpressionResult(node.arguments[0]);
    }
    if (ts.isNewExpression(node) && calleeName(node.expression) === "Error" && node.arguments?.[0]) {
      translateExpressionResult(node.arguments[0]);
    }
    if (isImportLiteral(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (replacements.length === 0) continue;
  replacements.sort((a, b) => b.start - a.start);
  let output = source;
  for (const replacement of replacements) {
    output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end);
  }
  if (!/from\s+["'][^"']*i18n\/index\.ts["']/.test(output)) {
    const imports = sf.statements.filter(ts.isImportDeclaration);
    const insertion = imports.length ? imports.at(-1).end : 0;
    output = `${output.slice(0, insertion)}\nimport { tr } from ${JSON.stringify(relativeImport(file))};${output.slice(insertion)}`;
  }
  changedFiles++;
  replacementsMade += replacements.length;
  if (process.argv.includes("--files")) {
    console.log(`${path.relative(root, file)}: ${replacements.length}`);
  }
  if (write) await writeFile(file, output);
}

const sortedEntries = [...entries].sort(([a], [b]) => a.localeCompare(b));
const english = `/**\n * Canonical English messages. Other locale catalogs are checked against this\n * object in tests so a missing translation can never silently ship.\n */\nexport const en = {\n${sortedEntries.map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`).join("\n")}\n} as const;\n\nexport type TranslationKey = keyof typeof en;\n`;
if (write) await writeFile(englishPath, english);

console.log(JSON.stringify({
  mode: write ? "write" : "dry-run",
  filesScanned: files.length,
  changedFiles,
  replacements: replacementsMade,
  keys: entries.size,
}, null, 2));
if (process.argv.includes("--sample")) {
  console.log(sortedEntries.slice(0, 250).map(([key, value]) => `${key} = ${value}`).join("\n"));
}
