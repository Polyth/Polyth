import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { fragmentToMarkdown, snapshotSelection } from "../src/selectionSnapshot.ts";

const dom = new Window({ url: "http://localhost/" });
const html = (markup: string) => {
  const root = dom.document.createElement("div");
  root.innerHTML = markup;
  return root as unknown as Node;
};

test("a selection keeps its links, emphasis, lists and code as Markdown", () => {
  const markdown = fragmentToMarkdown(html(`
    <h2>Що обрати</h2>
    <p>Беріть <strong>restic</strong> через <a href="https://rclone.org/x">бекенд <em>rclone</em></a> і <code>--prune</code>.</p>
    <ul><li>Один <a href="https://a.example">лінк</a></li><li>Другий<ul><li>вкладений</li></ul></li></ul>
    <ol start="3"><li>Три</li></ol>
    <pre><code>restic forget</code><button>Copy</button></pre>
    <blockquote><p>Цитата</p></blockquote>
  `));
  assert.match(markdown, /^## Що обрати/);
  assert.match(markdown, /Беріть \*\*restic\*\* через \[бекенд \*rclone\*\]\(https:\/\/rclone\.org\/x\) і `--prune`\./);
  assert.match(markdown, /- Один \[лінк\]\(https:\/\/a\.example\)/);
  assert.match(markdown, /- Другий\s+- вкладений/);
  assert.match(markdown, /3\. Три/);
  assert.match(markdown, /```\nrestic forget\n```/);
  assert.match(markdown, /> Цитата/);
  assert.equal(markdown.includes("Copy"), false, "a code block's button is not content");
});

test("only a web link becomes a link, and chrome stays out", () => {
  const markdown = fragmentToMarkdown(html(`<a href="javascript:alert(1)">bad</a> <a href="/rel">rel</a> <span aria-hidden="true">hidden</span>`));
  assert.equal(markdown, "bad rel");
});

test("a snapshot names the message the selection starts in", () => {
  const root = html(`<div class="msg assistant" data-message-seq="11"><p id="a">Text <b>bold</b></p></div><div id="out">Outside</div>`) as unknown as HTMLElement;
  dom.document.body.append(root as never);
  const fake = (start: Element | null) => ({
    startContainer: start,
    cloneContents: () => html("Text <b>bold</b>"),
  }) as unknown as Range;
  const inside = snapshotSelection(fake(root.querySelector("#a")), "Text bold");
  assert.deepEqual(inside, { text: "Text bold", markdown: "Text **bold**", eventSeq: 11, messageRole: "assistant" });
  const outside = snapshotSelection(fake(root.querySelector("#out")), "Outside");
  assert.equal(outside.eventSeq, null);
  assert.equal(outside.messageRole, null);
  root.remove();
});
