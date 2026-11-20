import assert from "node:assert/strict";
import test from "node:test";

import { commentBody, issueBody } from "../src/format.ts";
import { REPO, report } from "./support.ts";

const context = { repo: REPO, branch: "attachments", fingerprint: "0123456789abcdef", reportJsonPath: "reports/x/report.json" };

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
