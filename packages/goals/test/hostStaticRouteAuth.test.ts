import test from "node:test";
import assert from "node:assert/strict";
import type { RouteRequest } from "@polyth/contracts";
import { goalRoutes } from "../src/serverEntry.ts";

const staticRequest = (): RouteRequest => ({
  path: "/",
  method: "GET",
  get space(): never {
    throw Object.assign(new Error("authentication required"), { code: "unauthorized" });
  },
} as unknown as RouteRequest);

test("goals routes decline the public SPA shell before resolving Space", async () => {
  assert.equal(await goalRoutes({} as never)(staticRequest()), false);
});
