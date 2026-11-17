import test from "node:test";
import assert from "node:assert/strict";
import { StringStream } from "@codemirror/language";
import { pythonParser } from "../widgets/python.ts";
import { languageLabelOf, languageOf } from "../widgets/languages.ts";

type State = ReturnType<NonNullable<typeof pythonParser.startState>>;

/** Tokenize `source` line by line: every styled token as [text, style]. */
function tokens(source: string): Array<[string, string]> {
  const state = pythonParser.startState!(4) as State;
  const out: Array<[string, string]> = [];
  for (const line of source.split("\n")) {
    if (!line) {
      pythonParser.blankLine?.(state, 4);
      continue;
    }
    const stream = new StringStream(line, 4, 4);
    while (!stream.eol()) {
      const style = pythonParser.token(stream, state);
      if (style) out.push([stream.current(), style]);
      stream.start = stream.pos;
    }
  }
  return out;
}

const styleOf = (source: string, text: string) => tokens(source).find(([value]) => value === text)?.[1];

/** The indentation the editor would give a new line typed after `source`. */
function indentAfter(source: string, textAfter = ""): number | null {
  const state = pythonParser.startState!(4) as State;
  for (const line of source.split("\n")) {
    const stream = new StringStream(line, 4, 4);
    while (!stream.eol()) {
      pythonParser.token(stream, state);
      stream.start = stream.pos;
    }
  }
  return pythonParser.indent!(state, textAfter, { unit: 4 } as never);
}

test(".py, .pyi and .pyw open as Python", () => {
  assert.equal(languageOf("tests/cli/test_cli_scan.py")?.id, "python");
  assert.equal(languageOf("stubs/core.pyi")?.id, "python");
  assert.equal(languageOf("tool.pyw")?.id, "python");
  assert.equal(languageLabelOf("main.py"), "Python");
});

test("keywords, constants, definitions and attributes get their own styles", () => {
  const source = [
    "from pathlib import Path",
    "def _run_module(*args: str, cwd: Path | None = None) -> int:",
    "    return subprocess.run(args, check=False)",
    "class Scanner(Base):",
    "    ok = True",
  ].join("\n");
  assert.equal(styleOf(source, "from"), "keyword");
  assert.equal(styleOf(source, "import"), "keyword");
  assert.equal(styleOf(source, "def"), "keyword");
  assert.equal(styleOf(source, "_run_module"), "variableName.function.definition");
  assert.equal(styleOf(source, "None"), "null");
  assert.equal(styleOf(source, "True"), "bool");
  assert.equal(styleOf(source, "->"), "operator");
  assert.equal(styleOf(source, "run"), "propertyName");
  assert.equal(styleOf(source, "Scanner"), "className.definition");
  assert.equal(styleOf(source, "Base"), "variableName");
});

test("strings: prefixes, escapes, and triple quotes across lines", () => {
  const source = [
    'x = f"trailing {stdout[end:]!r}"',
    "y = rb'\\''",
    '"""Tests for the',
    "scan surface. # not a comment",
    '"""',
    "z = 1  # a comment",
  ].join("\n");
  const list = tokens(source);
  assert.deepEqual(list.find(([text]) => text.startsWith("f\"")), ['f"trailing {stdout[end:]!r}"', "string"]);
  assert.deepEqual(list.find(([text]) => text.startsWith("rb")), ["rb'\\''", "string"]);
  assert.deepEqual(list.filter(([, style]) => style === "string").map(([text]) => text).slice(2), [
    '"""Tests for the',
    "scan surface. # not a comment",
    '"""',
  ]);
  assert.equal(styleOf(source, "# a comment"), "comment");
  assert.equal(styleOf(source, "1"), "number");
});

test("numbers in every literal form", () => {
  for (const literal of ["0x_ff", "0o17", "0b1010", "1_000", "3.14", ".5", "1e-9", "2j", "10."]) {
    assert.deepEqual(tokens(`n = ${literal}`).at(-1), [literal, "number"], literal);
  }
});

test("a decorator is meta only at the head of a line; @ elsewhere is matmul", () => {
  assert.equal(styleOf("@pytest.fixture(scope='module')", "@pytest.fixture"), "meta");
  assert.equal(styleOf("c = a @ b", "@"), "operator");
});

test("soft keywords only where Python reads them as keywords", () => {
  assert.equal(styleOf("match command:", "match"), "keyword");
  assert.equal(styleOf("    case [x, y]:", "case"), "keyword");
  assert.equal(styleOf("type Pair[T] = tuple[T, T]", "type"), "keyword");
  assert.equal(styleOf("match = re.match(pattern, text)", "match"), "variableName");
  assert.equal(styleOf("type(value)", "type"), "variableName");
});

test("indents after a block colon, inside brackets, and dedents else/except", () => {
  assert.equal(indentAfter("def f():"), 4);
  assert.equal(indentAfter("    return x"), 4);
  assert.equal(indentAfter("result = run(\n    a,"), 4);
  assert.equal(indentAfter("result = run(\n    a,", ")"), 0);
  assert.equal(indentAfter("if ok:\n    go()", "else:"), 0);
  assert.equal(indentAfter("x = 1  # done:"), 0);
  assert.equal(indentAfter('doc = """\n  text'), null);
});
