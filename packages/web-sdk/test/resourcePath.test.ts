import test from "node:test";
import assert from "node:assert/strict";
import { compactResourcePath } from "../src/resourcePath.ts";

test("resource paths retain whole end segments and a leading root where space allows", () => {
  const path = "packages/server/src/features/auth/session/refreshToken.ts";
  assert.equal(compactResourcePath(path, 40), "packages/…/auth/session/refreshToken.ts");
  assert.equal(compactResourcePath(path, 30), "packages/…/refreshToken.ts");
  assert.equal(compactResourcePath(path, 20), "…/refreshToken.ts");
  assert.equal(compactResourcePath("src/app.ts"), "src/app.ts");
});

test("resource path shortening never cuts the filename or a Unicode segment", () => {
  assert.equal(compactResourcePath("src/a-very-long-filename.ts", 8), "a-very-long-filename.ts");
  assert.equal(compactResourcePath("packages/сервер/дані/сеанс.ts", 24), "packages/…/дані/сеанс.ts");
});
