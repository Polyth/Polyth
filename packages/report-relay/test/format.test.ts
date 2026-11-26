import assert from "node:assert/strict";
import test from "node:test";

import { commentBody, issueBody } from "../src/format.ts";
import { REPO, report } from "./support.ts";

const group = { id: "qa-eu", label: "QA EU", keyId: "qa-eu" };
const context = { repo: REPO, branch: "attachments", fingerprint: "0123456789abcdef", reportJsonPath: "reports/x/report.json", group };

// Live text outside code: a mention or an issue reference GitHub would act on.
const liveMentions = (markdown: string): string[] => {
  const outside = markdown.split(/^````json$[\s\S]*?^````$/m).join("\n");
  return [...outside.matchAll(/(?:^|[^\w`])(@[A-Za-z0-9-]+|#\d+)/g)].map((match) => match[1]!);
};

test("text the person or their machine wrote can never ping or cross-link", () => {
  const breakout = report({
    text: "cc @octocat see #12",
    errors: [{ time: new Date().toISOString(), text: "Error: x\n````\n@octocat please look at #7\n````" }],
    settings: { "ui.defaultModel": "@team/#3" },
  });
  for (const markdown of [issueBody(breakout, context), commentBody(breakout, context)]) {
    assert.deepEqual(liveMentions(markdown), [], markdown);
    // The error's own fence cannot close the details block early.
    assert.equal((markdown.match(/^````/gm) ?? []).length, 2);
  }
});

test("a table cell cannot break out of its column", () => {
  const base = report();
  const markdown = issueBody(report({ web: { ...base.web, view: "chat\\|x | y\r\nz" } }), context);
  assert.ok(markdown.includes("| View | chat\\\\\\|x \\| y z |"), markdown);
});

test("a browser report names its browser and server instead of a desktop build", async () => {
  const { issueLabels, issueTitle } = await import("../src/format.ts");
  const base = report();
  const browser = report({
    text: "Sidebar overlaps on the phone",
    app: {
      client: "browser", version: base.app.version, channel: base.app.channel, edition: "standard", platform: "ios",
      browser: "Safari 18", serverPlatform: "linux", serverArch: "x64", locale: "uk",
    },
  });
  assert.equal(issueTitle(browser), `[${base.app.version}] Sidebar overlaps on the phone · ios Safari 18`);
  assert.ok(issueLabels(browser, group).includes("client:browser"));
  assert.ok(!issueLabels(base, group).includes("client:browser"));
  const body = issueBody(browser, context);
  assert.match(body, /\| Client \| browser \|/);
  assert.match(body, /\| Browser \| Safari 18 \|/);
  assert.match(body, /\| Server \| linux x64 \|/);
  assert.doesNotMatch(body, /Electron|undefined/);
  assert.match(commentBody(browser, context), /· ios Safari 18 · browser ·/);
});
