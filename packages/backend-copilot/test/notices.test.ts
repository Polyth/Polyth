import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCopilotFailure, copilotAgentNotice } from "../src/notices.ts";

const chunk = (text: string, messageId?: string) => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
  ...(messageId ? { messageId } : {}),
});

test("model text is never a notice, whatever it says", () => {
  assert.equal(copilotAgentNotice(chunk("Error: the test failed because…", "9a757748")), undefined);
  assert.equal(copilotAgentNotice(chunk("Info: nothing to do", "9a757748")), undefined);
  assert.equal(copilotAgentNotice(chunk("Hello")), undefined);
  assert.equal(copilotAgentNotice({ sessionUpdate: "agent_message_chunk", content: { type: "image" } }), undefined);
});

test("the CLI's own status lines are hidden", () => {
  // Both verified on the wire of Copilot CLI 1.0.109.
  assert.deepEqual(copilotAgentNotice(chunk("Info: Operation cancelled by user")), { kind: "drop" });
  assert.deepEqual(copilotAgentNotice(chunk("Info: Request failed due to a transient API error. Retrying...")), { kind: "drop" });
});

test("the CLI's failure line ends the turn with its cause", () => {
  // Verified on the wire: a provider answering 401.
  const notice = copilotAgentNotice(chunk("Error: Authentication failed with provider at http://127.0.0.1:1/v1 (HTTP 401).\n  Check your COPILOT_PROVIDER_API_KEY."));
  assert.equal(notice?.kind, "error");
  assert.equal(notice?.kind === "error" && notice.code, "auth-expired");
  assert.match(notice?.kind === "error" ? notice.message : "", /^GitHub Copilot sign-in was refused: Authentication failed with provider .* Check your COPILOT_PROVIDER_API_KEY\.$/);
});

test("failures are classified from their text", () => {
  const code = (text: string) => classifyCopilotFailure(text).code;
  assert.equal(code("You have exceeded your premium request allowance for this month"), "quota-exhausted");
  assert.equal(code("Rate limit exceeded (HTTP 429). Try again in 30 seconds."), "rate-limited");
  assert.equal(code("The service is overloaded (HTTP 503)"), "overloaded");
  assert.equal(code("model resolution leaf failed: Auto is unavailable for this account; choose a concrete model"), "model-unavailable");
  assert.equal(code("The model gpt-9 is not available for your plan"), "model-unavailable");
  assert.equal(code("prompt is too long for the context window"), "context-full");
  assert.equal(code("Something broke"), undefined);
  assert.deepEqual(classifyCopilotFailure("Rate limit exceeded").retry, { scope: "rate", provider: "github-copilot", retryable: true });
  assert.equal(classifyCopilotFailure("Quota exceeded").retry?.retryable, false);
  assert.ok(classifyCopilotFailure("x".repeat(2_000)).message.length < 500);
});
