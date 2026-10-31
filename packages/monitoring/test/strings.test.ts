import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { MONITORING_TABLES, monitoringWords } from "../widgets/strings.ts";

const LOCALES = ["de", "fr", "pl", "pt-BR", "it", "es", "zh-CN", "bg", "ar", "pt"];

// Every t("English", "Українська") call in the widgets, read from source so a
// new phrase cannot ship without its translations.
function phrases(): string[] {
  const found = new Set<string>();
  for (const name of ["index.tsx", "MonitoringView.tsx"]) {
    const path = new URL(`../widgets/${name}`, import.meta.url);
    const source = ts.createSourceFile(name, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t") {
        const [english, ukrainian] = node.arguments;
        assert.ok(english && ts.isStringLiteralLike(english) && ukrainian && ts.isStringLiteralLike(ukrainian), `${name}: t() takes two string literals: ${node.getText(source).slice(0, 80)}`);
        found.add(english.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...found];
}

test("every monitoring phrase is translated in every non-English locale", () => {
  const all = phrases();
  assert.ok(all.length > 50);
  for (const locale of LOCALES) {
    const table = MONITORING_TABLES[locale];
    assert.ok(table, `${locale} table exists`);
    const missing = all.filter((english) => !table[english]?.trim());
    assert.deepEqual(missing, [], `${locale} misses ${missing.length} phrases`);
    const stale = Object.keys(table).filter((english) => !all.includes(english));
    assert.deepEqual(stale, [], `${locale} keeps phrases the widgets no longer use`);
  }
});

test("monitoringWords picks the locale, its language, Ukrainian inline, or English", () => {
  assert.equal(monitoringWords("uk")("Logs", "Логи"), "Логи");
  assert.equal(monitoringWords("uk-UA")("Logs", "Логи"), "Логи");
  assert.equal(monitoringWords("en")("Logs", "Логи"), "Logs");
  assert.equal(monitoringWords("xx")("Logs", "Логи"), "Logs");
  assert.equal(monitoringWords("de")("Logs", "Логи"), MONITORING_TABLES.de!["Logs"]);
  assert.equal(monitoringWords("zh")("Logs", "Логи"), MONITORING_TABLES["zh-CN"]!["Logs"]);
});
