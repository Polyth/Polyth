// Item ids, form validation, problem reports and reading a block's own reply
// back from history (pure parser layer).
import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_BLOCK_MAX_PROBLEMS,
  actionMessage,
  answeredBy,
  fieldError,
  formMessage,
  itemLabel,
  parseChatBlock,
  problemsMessage,
  selectionLabels,
  withRecords,
  type ChatBlockDoc,
  type FormField,
} from "../src/parse.ts";

const doc = (text: string, closed = true): ChatBlockDoc => {
  const result = parseChatBlock(text, closed);
  assert.equal(result.ok, true, `expected a block for ${JSON.stringify(text)}`);
  return (result as { ok: true; doc: ChatBlockDoc }).doc;
};
const LABELS = { send: "Send", yes: "yes", no: "no" };
const field = (d: ChatBlockDoc, name: string): FormField => d.items.find((item) => item.field?.name === name)!.field!;

// ------------------------------------------------------------------ ids

test("an id= field names the item in click messages and never shows as a field", () => {
  const d = doc([
    "cards Hotels · pick=many",
    "- https://x.example/a.jpg | Aurora | Old town | $120 | id=h-142 | https://x.example/a",
    "- Borealis | Harbour | $99 | tone=success | id=h-7",
    "- Cosmos | Centre",
  ].join("\n"));
  assert.equal(d.items[0]!.id, "h-142");
  assert.equal(d.items[0]!.value, "$120", "the id field does not shift the positional fields");
  assert.equal(d.items[0]!.link, "https://x.example/a");
  assert.equal(d.items[1]!.tone, "success");
  assert.equal(d.items[2]!.id, undefined);
  assert.deepEqual(d.items.map(itemLabel), ["Aurora (#h-142)", "Borealis (#h-7)", "Cosmos"]);
  assert.equal(actionMessage({ label: "Book" }, [itemLabel(d.items[0]!), itemLabel(d.items[2]!)]), "Book: Aurora (#h-142), Cosmos");
});

test("choice and media rows take an id too; ids with spaces are not ids", () => {
  const choice = doc("choice Plan\n- Basic | cheap | id=p1\n- Pro | id=has space");
  assert.equal(choice.items[0]!.id, "p1");
  assert.equal(choice.items[0]!.subtitle, "cheap");
  assert.equal(choice.items[1]!.id, undefined);
  const media = doc("media Shots\n- https://x.example/1.png | One | id=s1");
  assert.equal(media.items[0]!.id, "s1");
  assert.equal(media.items[0]!.title, "One");
});

test("file records carry an id key (or the one map=id: names)", () => {
  const records = [{ name: "Aurora", price: 120, id: "h-142" }, { name: "Cosmos", price: 80, sku: 7 }];
  const byKey = withRecords(doc("cards Hotels · from=_out/h.json"), records);
  assert.deepEqual(byKey.items.map(itemLabel), ["Aurora (#h-142)", "Cosmos"]);
  const mapped = withRecords(doc("list Hotels · from=_out/h.json · map=id:sku"), records);
  assert.deepEqual(mapped.items.map(itemLabel), ["Aurora", "Cosmos (#7)"]);
});

// ------------------------------------------------------------- forms

test("form fields take email/url types, number/date ranges and text patterns", () => {
  const d = doc([
    "form Sign up",
    "- email | Email * | email",
    "- site | Website | url",
    "- age | Age | number | 30 | 18..120",
    "- start | Start | date | | 2026-01-01..",
    "- code | Code | text | | /[A-Z]{3}-\\d+/",
    "- size | Size | | | S/M/L",
  ].join("\n"));
  assert.equal(field(d, "email").type, "email");
  assert.equal(field(d, "site").type, "url");
  assert.deepEqual([field(d, "age").min, field(d, "age").max], ["18", "120"]);
  assert.deepEqual([field(d, "start").min, field(d, "start").max], ["2026-01-01", undefined]);
  assert.equal(field(d, "code").pattern, "[A-Z]{3}-\\d+");
  assert.equal(field(d, "size").type, "select", "options without a type still make a select");
  assert.deepEqual(d.problems, []);
});

test("fieldError separates missing from invalid values", () => {
  const d = doc([
    "form F",
    "- email | Email * | email",
    "- site | Site | url",
    "- age | Age | number | | 18..120",
    "- start | Start | date | | 2026-01-01..2026-12-31",
    "- code | Code | text | | /[A-Z]{3}/",
    "- pick | Pick * | select | | a, b",
    "- ok | OK | toggle",
  ].join("\n"));
  assert.equal(fieldError(field(d, "email"), ""), "missing");
  assert.equal(fieldError(field(d, "email"), "me@"), "invalid");
  assert.equal(fieldError(field(d, "email"), "me@x.io"), null);
  assert.equal(fieldError(field(d, "site"), ""), null, "an optional empty field is fine");
  assert.equal(fieldError(field(d, "site"), "example.com"), "invalid");
  assert.equal(fieldError(field(d, "site"), "https://example.com"), null);
  assert.equal(fieldError(field(d, "age"), "17"), "invalid");
  assert.equal(fieldError(field(d, "age"), "121"), "invalid");
  assert.equal(fieldError(field(d, "age"), "40"), null);
  assert.equal(fieldError(field(d, "age"), "forty"), "invalid");
  assert.equal(fieldError(field(d, "start"), "2025-12-31"), "invalid");
  assert.equal(fieldError(field(d, "start"), "2026-06-01"), null);
  assert.equal(fieldError(field(d, "code"), "ABCD"), "invalid", "a pattern matches the whole value");
  assert.equal(fieldError(field(d, "code"), "ABC"), null);
  assert.equal(fieldError(field(d, "pick"), ""), "missing");
  assert.equal(fieldError(field(d, "ok"), ""), null);
});

test("bad field types, ranges and patterns are reported and ignored", () => {
  const d = doc([
    "form F",
    "- a | A | phone-ish",
    "- b | B | number | | ten..20",
    "- c | C | text | | /([a-z/",
    "- d | D | toggle | | 1..2",
  ].join("\n"));
  assert.equal(field(d, "a").type, "text");
  assert.equal(field(d, "b").min, undefined);
  assert.equal(field(d, "c").pattern, undefined);
  assert.deepEqual(d.problems.map((p) => [p.code, p.line]), [["bad-field", 2], ["bad-field", 3], ["bad-field", 4], ["bad-field", 5]]);
  assert.match(d.problems[0]!.hint, /text, textarea, number/);
});

// ----------------------------------------------------------- problems

test("problems name the line, the text and how the row should look", () => {
  const d = doc([
    "cards Shops · pick=sometimes · zoom=2 · sort=price · ratio=0:1",
    "- |",
    "> ",
    "- A",
    "> Go =",
  ].join("\n"));
  assert.deepEqual(d.problems.map((p) => [p.code, p.line, p.text]), [
    ["bad-option", 1, "pick=sometimes"],
    ["unknown-option", 1, "zoom=2"],
    ["bad-option", 1, "sort=price"],
    ["bad-option", 1, "ratio=0:1"],
    ["bad-row", 2, "- |"],
    ["bad-button", 3, ">"],
  ]);
  assert.match(d.problems[1]!.hint, /^cards options: pick, sort/);
  assert.match(d.problems[4]!.hint, /image \| title \| subtitle/);
  assert.deepEqual(d.invalid, [">", "- |"], "invalid keeps its old meaning");
});

test("limits, rejected paths and invalid buttons are problems too", () => {
  const rows = Array.from({ length: 203 }, (_, i) => `- Row ${i}`).join("\n");
  const many = doc(`list Many\n${rows}\n${Array.from({ length: 8 }, (_, i) => `> B${i}`).join("\n")}`);
  assert.equal(many.items.length, 200);
  assert.deepEqual(many.problems.map((p) => [p.code, p.text]), [["too-many-buttons", "2 more"], ["too-many-rows", "3 more"]]);
  const wide = doc(`table T\n- ${Array.from({ length: 14 }, (_, i) => `c${i}`).join(" | ")}`);
  assert.equal(wide.problems[0]!.code, "too-many-fields");
  assert.equal(wide.problems[0]!.line, 2);
  const path = doc("table X · from=../secret.json");
  assert.equal(path.problems[0]!.code, "bad-source");
  const capped = doc(`list L\n${Array.from({ length: 40 }, () => "- |").join("\n")}`);
  assert.equal(capped.problems.length, CHAT_BLOCK_MAX_PROBLEMS);
  assert.equal(capped.invalid.length, 40);
});

test("a clean block has no problems, and a table header or compare header is not one", () => {
  for (const text of [
    "table T\n- a | b\n- 1 | 2",
    "compare C\n- | A | B\n- Price ↓ | 1 | 2",
    "chart C · type=line · unit=%\n- Jan | 1",
    "steps P\n- done | One",
    "cards C · pick=one · ratio=16:9 · sort=-value · send=draft\n- A",
  ]) assert.deepEqual(doc(text).problems, [], text);
});

test("the fix request quotes the problems with their hints", () => {
  const d = doc("cards Shops · zoom=2\n- |");
  const message = problemsMessage(d.title, d.view, d.problems);
  assert.equal(message, [
    "The ```ui block “Shops” did not render cleanly:",
    "- line 1: `zoom=2` — cards options: pick, sort, ratio, from, map, send.",
    "- line 2: `- |` — A cards row is - image | title | subtitle | value | badge | link (a title or an image is required).",
    "Please send the block again, corrected.",
  ].join("\n"));
});

// ------------------------------------------------------------ answered

test("a reply that one of the block's buttons sends is recognised, with its selection", () => {
  const d = doc([
    "cards Hotels · pick=many",
    "- Aurora, Old Town | x | id=h-1",
    "- Aurora | y",
    "- Cosmos | z",
    "> Compare = Compare in detail: {sel}",
    "> Book",
  ].join("\n"));
  const labels = selectionLabels(d).map((entry) => entry.label);
  assert.deepEqual(labels, ["Aurora, Old Town (#h-1)", "Aurora", "Cosmos"]);
  const compare = actionMessage(d.actions[0]!, [labels[0]!, labels[1]!]);
  assert.deepEqual(answeredBy(d, compare, LABELS), { message: compare, selected: [0, 1] });
  assert.deepEqual(answeredBy(d, "Book: Cosmos", LABELS), { message: "Book: Cosmos", selected: [2] });
  assert.deepEqual(answeredBy(d, "  Book  ", LABELS), { message: "Book", selected: [] });
  assert.equal(answeredBy(d, "Book: Nebula", LABELS), null, "a name that is not an item is not this block's reply");
  assert.equal(answeredBy(d, "Thanks, booking Cosmos", LABELS), null);
  assert.equal(answeredBy(d, undefined, LABELS), null);
});

test("choice and form replies come back with their answer and values", () => {
  const choice = doc("choice Which plan?\n- Basic\n- Pro | id=p2");
  assert.deepEqual(answeredBy(choice, "Which plan? — Pro (#p2)", LABELS), { message: "Which plan? — Pro (#p2)", selected: [1] });
  assert.equal(answeredBy(choice, "Which plan? — ", LABELS), null);

  const form = doc("form Trip\n- city | City * | text\n- notes | Notes | textarea\n- kids | Kids | toggle");
  const values = { city: "Lviv; centre", notes: "", kids: "true" };
  const message = formMessage(form, values, LABELS);
  assert.equal(message, "Trip — City: Lviv; centre; Kids: yes");
  assert.deepEqual(answeredBy(form, message, LABELS), { message, values: { city: "Lviv; centre", kids: "true" } });
  assert.equal(answeredBy(form, "Trip — Town: Lviv", LABELS), null);
  const custom = doc("form Trip\n- city | City\n> Plan it = Plan a trip");
  assert.deepEqual(answeredBy(custom, "Plan a trip — City: Kyiv", LABELS)?.values, { city: "Kyiv" });
});

test("a compare reply names columns", () => {
  const d = doc("compare Laptops · pick=one\n- | Air 13 | XPS 13\n- Battery ↑ | 18 h | 12 h\n> Buy");
  assert.deepEqual(answeredBy(d, "Buy: XPS 13", LABELS), { message: "Buy: XPS 13", selected: [1] });
});

test("a block without buttons never claims a reply", () => {
  assert.equal(answeredBy(doc("table T\n- a\n- 1"), "a", LABELS), null);
  assert.equal(answeredBy(doc("stats S\n- Users | 10"), "Users", LABELS), null);
});
