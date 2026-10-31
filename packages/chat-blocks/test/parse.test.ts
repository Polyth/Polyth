import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_BLOCK_VIEWS,
  actionMessage,
  chatBlockMarkdown,
  deltaDirection,
  numericValue,
  parseChatBlock,
  splitFields,
  type ChatBlockDoc,
} from "../src/parse.ts";
import { CHAT_BLOCKS_REFERENCE, CHAT_BLOCKS_RULE } from "../src/rule.ts";

const doc = (text: string, closed = true): ChatBlockDoc => {
  const result = parseChatBlock(text, closed);
  assert.equal(result.ok, true, `expected a block for ${JSON.stringify(text)}`);
  return (result as { ok: true; doc: ChatBlockDoc }).doc;
};

const CARDS = [
  "cards Навушники до 15 000 ₴ · pick=many · sort=value",
  "- https://cdn.example/xm6.jpg | Sony WH-1000XM6 | ANC · 30 год | 14 999 ₴ | ★4.8 | https://shop.example/xm6",
  "- [x] https://cdn.example/qc.jpg | Bose QC Ultra | комфорт | 13 499 ₴ | ★4.7",
  "- B&W Px8 | звук, шкіра | 14 200 ₴",
  "> Порівняти обрані = Порівняй детально: {sel}",
  "> Ще варіанти",
].join("\n");

test("the header splits view, title and options; title keeps its own middle dots", () => {
  const d = doc(CARDS);
  assert.equal(d.view, "cards");
  assert.equal(d.title, "Навушники до 15 000 ₴");
  assert.deepEqual(d.options, { pick: "many", sort: "value" });
  assert.equal(d.pick, "many");
  assert.equal(doc("list Shops near me pick=one ratio=1:1").title, "Shops near me");
  assert.deepEqual(doc("list Shops near me pick=one ratio=1:1").options, { pick: "one", ratio: "1:1" });
});

test("media rows map positional fields with optional leading image and trailing link", () => {
  const [sony, bose, bw] = doc(CARDS).items;
  assert.deepEqual(
    { image: sony!.image, title: sony!.title, subtitle: sony!.subtitle, value: sony!.value, badge: sony!.badge, link: sony!.link },
    { image: "https://cdn.example/xm6.jpg", title: "Sony WH-1000XM6", subtitle: "ANC · 30 год", value: "14 999 ₴", badge: "★4.8", link: "https://shop.example/xm6" },
  );
  assert.equal(bose!.selected, true);
  assert.equal(bose!.link, undefined);
  // No image: the first field is the title, not an image.
  assert.equal(bw!.image, undefined);
  assert.equal(bw!.title, "B&W Px8");
  assert.equal(bw!.value, "14 200 ₴");
});

test("a project image path counts as an image, plain words do not", () => {
  const d = doc("list X\n- shots/a.png | Home page | 1440px\n- Plain | row");
  assert.equal(d.items[0]!.image, "shots/a.png");
  assert.equal(d.items[1]!.image, undefined);
  assert.equal(doc("list X\n- javascript:x.png | Bad").items[0]!.image, undefined, "a scheme is never an image path");
});

test("a tone field colours the badge and is not a positional field", () => {
  const [row] = doc("list Stock\n- Rozetka | завтра | 14 999 ₴ | в наявності | tone=success").items;
  assert.equal(row!.badge, "в наявності");
  assert.equal(row!.tone, "success");
  assert.equal(doc("list S\n- A | b | c | d | tone=purple").items[0]!.tone, undefined);
});

test("buttons carry their label and an optional message template", () => {
  const { actions } = doc(CARDS);
  assert.deepEqual(actions, [{ label: "Порівняти обрані", message: "Порівняй детально: {sel}" }, { label: "Ще варіанти" }]);
  assert.equal(actionMessage(actions[0]!, ["Sony", "Bose"]), "Порівняй детально: Sony, Bose");
  assert.equal(actionMessage(actions[1]!, []), "Ще варіанти");
  assert.equal(actionMessage(actions[1]!, ["Sony"]), "Ще варіанти: Sony");
  assert.equal(actionMessage({ label: "Go", message: "Book it" }, ["A"]), "Book it: A");
});

test("table uses the first row as headers unless cols= names them", () => {
  const d = doc("table Deps · sort=-severity\n- name | version | severity\n- lodash | 4.17.20 | high\n- axios | 0.21.1 | critical");
  assert.deepEqual(d.columns, ["name", "version", "severity"]);
  assert.equal(d.items.length, 2);
  assert.deepEqual(d.items[1]!.cells, ["axios", "0.21.1", "critical"]);
  assert.equal(d.pick, "none");
  const named = doc("table Deps cols=a,b\n- 1 | 2");
  assert.deepEqual(named.columns, ["a", "b"]);
  assert.equal(named.items.length, 1);
});

test("a table also accepts Markdown pipe rows, a separator rule and bulletless rows", () => {
  // A model that copies a Markdown table leaves out the `- ` row marker; the
  // first pipe line is the header and the `|---|` rule is not a row.
  const markdown = doc([
    "table Channels",
    "| Variant | Speed | Cost |",
    "| --- | :---: | ---: |",
    "| Balance | one stream | medium |",
    "| MPTCP | aggregated | high |",
  ].join("\n"));
  assert.deepEqual(markdown.columns, ["Variant", "Speed", "Cost"]);
  assert.deepEqual(markdown.items.map((item) => item.cells), [["Balance", "one stream", "medium"], ["MPTCP", "aggregated", "high"]]);
  assert.deepEqual(markdown.notes, []);
  assert.deepEqual(markdown.problems, []);

  // The same shape without the wrapping bars, all the way through.
  const plain = doc("table T\nVariant | Cost\nA | 1\nB | 2");
  assert.deepEqual(plain.columns, ["Variant", "Cost"]);
  assert.deepEqual(plain.items.map((item) => item.cells), [["A", "1"], ["B", "2"]]);

  // Pipe prose stays a caption in every other view.
  const prose = doc("list L\nSome note | with a bar\n- A");
  assert.deepEqual(prose.notes, ["Some note | with a bar"]);
});

test("bullets other than a hyphen and numbered rows are still rows", () => {
  const d = doc("list L\n• First | one\n* Second | two\n+ Third | three\n1. Fourth | four\n2) Fifth | five");
  assert.deepEqual(d.items.map((item) => item.title), ["First", "Second", "Third", "Fourth", "Fifth"]);
  assert.deepEqual(d.notes, []);
});

test("stats parse value, delta and sparkline; choice defaults to a single pick", () => {
  const [revenue] = doc("stats Week\n- Revenue | 412k ₴ | +12% | 3,4,3.6,5,7").items;
  assert.equal(revenue!.value, "412k ₴");
  assert.equal(revenue!.badge, "+12%");
  assert.deepEqual(revenue!.spark, [3, 4, 3.6, 5, 7]);
  const choice = doc("choice How do we update?\n- [x] Critical only | lowest risk\n- [x] Everything");
  assert.equal(choice.pick, "one");
  assert.deepEqual(choice.items.map((item) => item.selected), [true, false], "one preselection survives in single mode");
  assert.equal(doc("choice Which? · pick=many\n- A\n- B").pick, "many");
});

test("escaped bars stay literal", () => {
  assert.deepEqual(splitFields("a \\| b | c"), ["a | b", "c"]);
});

test("streaming holds back the trailing partial line and reports it pending", () => {
  const partial = doc("cards Items\n- A | first\n- B | sec", false);
  assert.equal(partial.items.length, 1);
  assert.equal(partial.pending, true);
  const header = parseChatBlock("car", false);
  assert.deepEqual(header, { ok: false, reason: "unknown-view", view: "car" });
  assert.equal(doc("cards Items\n- A | first\n- B | second").items.length, 2);
  // Every streamed prefix parses without throwing.
  for (let i = 0; i <= CARDS.length; i++) parseChatBlock(CARDS.slice(0, i), false);
});

test("unknown views, empty fences and junk degrade instead of throwing", () => {
  assert.deepEqual(parseChatBlock(""), { ok: false, reason: "empty" });
  assert.deepEqual(parseChatBlock("kanban Board\n- a"), { ok: false, reason: "unknown-view", view: "kanban" });
  const d = doc("list L\nsome caption\n- | \n>");
  assert.deepEqual(d.notes, ["some caption"]);
  // A bare `>` is a button without a label, reported rather than shown as a caption.
  assert.deepEqual(d.invalid, [">", "- |"]);
  assert.deepEqual(d.problems.map((problem) => problem.code), ["bad-row", "bad-button"]);
});

test("rows and field lengths are bounded", () => {
  const many = ["list Big", ...Array.from({ length: 500 }, (_, i) => `- Item ${i}`)].join("\n");
  assert.equal(doc(many).items.length, 200);
  const long = doc(`list L\n- ${"x".repeat(5000)}`).items[0]!.title;
  assert.equal(long.length, 600);
});

test("numeric values read grouped, decimal-comma, signed and currency strings", () => {
  assert.equal(numericValue("14 999 ₴"), 14999);
  assert.equal(numericValue("$1,299.50"), 1299.5);
  assert.equal(numericValue("2,1%"), 2.1);
  assert.equal(numericValue("−12%"), -12);
  assert.equal(numericValue("1.234,5 €"), 1234.5);
  assert.equal(numericValue("n/a"), null);
  assert.equal(deltaDirection("+12%"), "up");
  assert.equal(deltaDirection("−0,6 п.п."), "down");
  assert.equal(deltaDirection("0%"), "flat");
});

test("Markdown export keeps the data readable outside Polyth", () => {
  assert.equal(
    chatBlockMarkdown(doc("table T\n- a | b\n- 1 | x\\|y")),
    "**T**\n\n| a | b |\n| --- | --- |\n| 1 | x\\|y |",
  );
  assert.equal(
    chatBlockMarkdown(doc("list Shops\n- Rozetka | завтра | 14 999 ₴ | в наявності | https://r.example")),
    "**Shops**\n\n- **[Rozetka](https://r.example)** · 14 999 ₴ · в наявності · завтра",
  );
});

test("the always-on rule stays small and names every view; the skill carries the full reference", () => {
  for (const view of CHAT_BLOCK_VIEWS) {
    assert.ok(CHAT_BLOCKS_RULE.includes(view), `rule names ${view}`);
    assert.ok(CHAT_BLOCKS_REFERENCE.includes(`\n${view} `), `reference documents ${view}`);
  }
  assert.ok(CHAT_BLOCKS_RULE.includes("```ui") && CHAT_BLOCKS_RULE.includes("from=") && CHAT_BLOCKS_RULE.includes("polyth-chat-blocks"));
  // ≈4 characters per token: the always-on cost stays near 300 tokens.
  assert.ok(CHAT_BLOCKS_RULE.length < 1300, `rule is ${CHAT_BLOCKS_RULE.length} chars`);
  const example = /```ui\n([\s\S]*?)\n```/.exec(CHAT_BLOCKS_RULE)![1]!;
  const parsed = doc(example);
  assert.equal(parsed.view, "cards");
  assert.equal(parsed.items[0]!.link, "https://example.com/a");
  assert.equal(parsed.actions.length, 1);
  // Every inline example in the reference parses to a known view.
  for (const line of CHAT_BLOCKS_REFERENCE.split("\n").filter((entry) => /^`(?:table|cards|chart) /.test(entry))) {
    const header = line.slice(1, line.indexOf("`", 1));
    assert.equal(parseChatBlock(header).ok, true, header);
  }
});
