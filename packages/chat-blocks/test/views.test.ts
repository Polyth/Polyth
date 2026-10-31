import test from "node:test";
import assert from "node:assert/strict";
import {
  bestIndex,
  chartType,
  niceCeil,
  chatBlockMarkdown,
  formMessage,
  parseChatBlock,
  sourcePath,
  withRecords,
  type ChatBlockDoc,
} from "../src/parse.ts";

const doc = (text: string, closed = true): ChatBlockDoc => {
  const result = parseChatBlock(text, closed);
  assert.equal(result.ok, true, `expected a block for ${JSON.stringify(text)}`);
  return (result as { ok: true; doc: ChatBlockDoc }).doc;
};

test("chart reads a header row as series names and numbers per series", () => {
  const d = doc("chart Revenue · type=line\n- Month | Online | Shop\n- Jan | 12 | 15\n- Feb | 9,5 | n/a\n- Mar | x | y");
  assert.deepEqual(d.series, ["Online", "Shop"]);
  // Numeric series names cannot be told apart from data; series= names them.
  assert.deepEqual(doc("chart R · series=2025,2026\n- Jan | 12 | 15").series, ["2025", "2026"]);
  assert.deepEqual(d.items.map((item) => [item.title, item.values]), [["Jan", [12, 15]], ["Feb", [9.5, null]]]);
  assert.deepEqual(d.invalid, ["- Mar | x | y"], "a row with no numbers is reported, not drawn");
  assert.deepEqual(doc("table T · from=a.json · cols=fixed:Fixed in,name · sort=-cvss").options, { from: "a.json", cols: "fixed:Fixed in,name", sort: "-cvss" });
  assert.equal(chartType(d), "line");
  assert.equal(chartType(doc("chart X · type=pie\n- a | 1")), "donut");
  assert.equal(chartType(doc("chart X\n- a | 1")), "bar");
});

test("chart without a header uses series= or numbered series", () => {
  assert.deepEqual(doc("chart Sales · series=Online,Shop\n- Q1 | 3 | 4").series, ["Online", "Shop"]);
  assert.deepEqual(doc("chart Sales\n- Q1 | 3").series, ["Sales"]);
  assert.deepEqual(doc("chart Sales\n- Q1 | 3 | 4").series, ["#1", "#2"]);
});

test("compare: header names objects, an image row adds pictures, arrows mark the winner", () => {
  const d = doc([
    "compare Laptops · pick=one",
    "- | Air 13 | XPS 13",
    "- image | https://x.example/a.jpg | https://x.example/b.png",
    "- Price ↓ | $999 | $1,199",
    "- Battery ↑ | 18 h | 12 h",
    "- Weight ↓ | 1.24 kg | 1.24 kg",
    "- Ports | 2 | 3",
  ].join("\n"));
  assert.deepEqual(d.columns, ["Air 13", "XPS 13"]);
  assert.deepEqual(d.columnImages, ["https://x.example/a.jpg", "https://x.example/b.png"]);
  assert.deepEqual(d.items.map((item) => [item.title, item.best, bestIndex(item)]), [
    ["Price", "min", 0],
    ["Battery", "max", 0],
    ["Weight", "min", -1],
    ["Ports", undefined, -1],
  ]);
  assert.equal(d.pick, "one");
});

test("form rows describe typed fields with defaults, options and required marks", () => {
  const d = doc([
    "form Trip details",
    "- city | City * | text | Lviv",
    "- nights | Nights | number | 2",
    "- room | Room | select | Double | Single, Double, Suite",
    "- breakfast | Breakfast | toggle | true",
    "- when | Date | date",
    "- notes | Notes | textarea",
    "- budget | Budget | select",
    "- size | Size | | M | S/M/L",
  ].join("\n"));
  assert.deepEqual(d.items.map((item) => [item.field!.name, item.field!.type, item.field!.required]), [
    ["city", "text", true], ["nights", "number", false], ["room", "select", false], ["breakfast", "toggle", false],
    ["when", "date", false], ["notes", "textarea", false], ["budget", "text", false], ["size", "select", false],
  ]);
  assert.equal(d.items[0]!.field!.label, "City");
  assert.deepEqual(d.items[2]!.field!.options, ["Single", "Double", "Suite"]);
  assert.deepEqual(d.items[7]!.field!.options, ["S", "M", "L"]);
  assert.equal(
    formMessage(d, { nights: "3", breakfast: "false", notes: "  " }, { yes: "yes", no: "no" }),
    "Trip details — City: Lviv; Nights: 3; Room: Double; Breakfast: no; Size: M",
  );
});

test("steps accept status words and symbols; rows without a status are todos", () => {
  const d = doc("steps Release\n- done | Build | 2 min\n- ✓ | Tests\n- running | Deploy\n- failed | Smoke\n- skip | Notify\n- Write notes");
  assert.deepEqual(d.items.map((item) => [item.status, item.title]), [
    ["done", "Build"], ["done", "Tests"], ["doing", "Deploy"], ["fail", "Smoke"], ["skip", "Notify"], ["todo", "Write notes"],
  ]);
  assert.equal(d.items[0]!.subtitle, "2 min");
  assert.equal(chatBlockMarkdown(d).split("\n")[2], "- [x] Build — 2 min");
});

test("media keeps image rows with captions and links", () => {
  const d = doc("media Screens\n- shots/home.png | Home | https://app.example\n- not an image | x\n- https://x.example/b.webp");
  assert.deepEqual(d.items.map((item) => [item.image, item.title, item.link]), [
    ["shots/home.png", "Home", "https://app.example"],
    ["https://x.example/b.webp", "", undefined],
  ]);
  assert.equal(d.invalid.length, 1);
});

test("from= accepts project data files only", () => {
  assert.equal(sourcePath("_out/data.json"), "_out/data.json");
  assert.equal(sourcePath("./a/b.CSV"), "a/b.CSV");
  for (const bad of ["/etc/passwd.json", "../x.json", "a/../b.csv", "~/x.json", "https://x/y.json", "a\\b.json", "a.txt", "a//b.json", ""]) {
    assert.equal(sourcePath(bad), null, bad);
  }
  const d = doc("table Deps · from=_out/deps.json · cols=name,version");
  assert.equal(d.source, "_out/deps.json");
  assert.deepEqual(d.columns, [], "cols= names record keys, not inline headers, when from= is set");
  assert.deepEqual(doc("table X · from=../secret.json").invalid, ["from=../secret.json"]);
});

test("records fill tables, charts and cards through cols= and map=", () => {
  const records = [
    { name: "axios", version: "0.21.1", cvss: 9.8, extra: { a: 1 } },
    { name: "lodash", version: "4.17.20", cvss: 7.4, extra: null },
  ];
  const table = withRecords(doc("table Deps · from=d.json · cols=name:Package,cvss:CVSS"), records);
  assert.deepEqual(table.columns, ["Package", "CVSS"]);
  assert.deepEqual(table.items.map((item) => item.cells), [["axios", "9.8"], ["lodash", "7.4"]]);
  assert.deepEqual(withRecords(doc("table Deps · from=d.json"), records).items[0]!.cells, ["axios", "0.21.1", "9.8", '{"a":1}']);

  const chart = withRecords(doc("chart CVSS · from=d.json"), records);
  assert.deepEqual(chart.series, ["cvss"]);
  assert.deepEqual(chart.items.map((item) => [item.title, item.values]), [["axios", [9.8]], ["lodash", [7.4]]]);

  const cards = withRecords(doc("cards Shop · from=p.jsonl · map=title:model,value:cost · pick=many"), [
    { model: "XM6", cost: "$399", thumbnail: "https://x.example/a.jpg", url: "https://shop.example/a", rating: "★4.8", selected: true, tone: "success" },
    { model: "QC", cost: "$379" },
  ], { total: 9000, truncated: true });
  assert.deepEqual(
    [cards.items[0]!.title, cards.items[0]!.value, cards.items[0]!.image, cards.items[0]!.link, cards.items[0]!.badge, cards.items[0]!.selected, cards.items[0]!.tone],
    ["XM6", "$399", "https://x.example/a.jpg", "https://shop.example/a", "★4.8", true, "success"],
  );
  assert.equal(cards.items[1]!.image, undefined);
  assert.deepEqual(cards.loaded, { total: 9000, truncated: true });
});

test("streaming new views never throws on any prefix", () => {
  const text = "compare A · pick=one\n- | X | Y\n- image | https://a.example/x.jpg | \n- Price ↓ | 1 | 2\n> Pick";
  for (let i = 0; i <= text.length; i++) parseChatBlock(text.slice(0, i), false);
  const form = "form F\n- a | A * | select | x | x, y\n- b | B | toggle";
  for (let i = 0; i <= form.length; i++) parseChatBlock(form.slice(0, i), false);
});

test("axis ends round up to clean numbers", () => {
  assert.deepEqual([2592, 7, 10, 0.37, 1, 101, 0, -3].map(niceCeil), [3000, 8, 10, 0.4, 1, 120, 1, 1]);
});
