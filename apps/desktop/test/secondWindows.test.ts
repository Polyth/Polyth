import { test } from "node:test";
import assert from "node:assert/strict";
import { secondWindowRequest } from "../src/secondWindows.ts";

const page = "http://127.0.0.1:4100/p/p1/s/s1";

test("a page may open its own chat and pane windows on its own origin", () => {
  assert.deepEqual(secondWindowRequest(page, "http://127.0.0.1:4100/p/p1/s/s2?window=chat"), {
    key: "http://127.0.0.1:4100 chat /p/p1/s/s2",
    url: "http://127.0.0.1:4100/p/p1/s/s2?window=chat",
  });
  assert.equal(secondWindowRequest(page, "http://127.0.0.1:4100/?session=s2&window=chat")?.key, "http://127.0.0.1:4100 chat s2");
  assert.equal(secondWindowRequest(page, "http://127.0.0.1:4100/p/p1?window=pane&surface=files")?.key, "http://127.0.0.1:4100 pane");
});

test("everything else stays an external link", () => {
  assert.equal(secondWindowRequest(page, "http://127.0.0.1:4100/p/p1"), null, "no role");
  assert.equal(secondWindowRequest(page, "http://127.0.0.1:4100/?window=settings"), null, "unknown role");
  assert.equal(secondWindowRequest(page, "http://127.0.0.1:4101/?window=chat"), null, "another origin");
  assert.equal(secondWindowRequest(page, "https://example.com/?window=chat"), null);
  assert.equal(secondWindowRequest("polyth-app://hub/", "polyth-app://hub/?window=chat"), null, "the server list opens none");
  assert.equal(secondWindowRequest(page, "http://user:pw@127.0.0.1:4100/?window=chat"), null);
  assert.equal(secondWindowRequest(page, "javascript:alert(1)"), null);
  assert.equal(secondWindowRequest("not a url", "http://127.0.0.1:4100/?window=chat"), null);
});

test("a pane window opened for one resource is that resource's own window", () => {
  const base = "http://127.0.0.1:4100/p/p1?window=pane&surface=page-apps";
  const one = secondWindowRequest(page, `${base}&resource=11111111-1111-4111-8111-111111111111`);
  const two = secondWindowRequest(page, `${base}&resource=22222222-2222-4222-8222-222222222222`);
  assert.equal(one?.key, "http://127.0.0.1:4100 pane page-apps 11111111-1111-4111-8111-111111111111");
  assert.notEqual(one?.key, two?.key, "two apps, two windows");
  assert.equal(secondWindowRequest(page, base)?.key, "http://127.0.0.1:4100 pane", "no resource: the one code window");
  assert.equal(secondWindowRequest(page, `${base}&resource=a%20b`)?.key, "http://127.0.0.1:4100 pane", "a resource is an id, not text");
  assert.equal(secondWindowRequest(page, "http://127.0.0.1:4100/?window=pane&resource=x")?.key, "http://127.0.0.1:4100 pane", "no surface");
});
