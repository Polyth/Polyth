import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SecureSafeCard from "../src/components/SecureSafeCard.tsx";
import { listSlots } from "../src/slots.ts";
import "../src/secureSafe.tsx";

test("Secure Safe request card is assertive and uses a write-only password field", () => {
  const html = renderToStaticMarkup(createElement(SecureSafeCard, {
    secrets: [{
      requestId: "request-1",
      handle: "deploy-token",
      label: "Deployment token",
      purpose: "Publish releases",
      kind: "token",
      existing: true,
      status: "pending",
      time: 1,
    }],
  }));

  assert.match(html, /role="alert"/);
  assert.match(html, /aria-live="assertive"/);
  assert.match(html, /Secure Safe — save credential/);
  assert.match(html, /Deployment token/);
  assert.match(html, /deploy-token/);
  assert.match(html, /Publish releases/);
  assert.match(html, /Will update existing handle/);
  assert.match(html, /type="password"/);
  assert.match(html, /autoComplete="off"/);
  assert.match(html, /Save to Secure Safe/);
  assert.match(html, /Dismiss/);
  assert.doesNotMatch(html, /credential-value/);
});

test("Secure Safe settings register through the settings page slot", () => {
  const item = listSlots("settings.pages").find((candidate) => candidate.id === "secure-safe");
  assert.ok(item);
  assert.equal(item.meta?.label, "Secure Safe");
  assert.equal(item.meta?.group, "Engineering");
  assert.deepEqual(
    (item.meta?.settingsItems as Array<{ focusTarget: string }>).map((entry) => entry.focusTarget),
    ["secure-safe.entries"],
  );
});
