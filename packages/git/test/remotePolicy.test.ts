import test from "node:test";
import { GIT_REMOTE_ACCESS } from "../src/serverEntry.ts";
import { validateRemoteAccessPolicy } from "../../server/src/remotePolicy.ts";

test("Git remote policy validates before routes are enabled", () => {
  validateRemoteAccessPolicy("git", GIT_REMOTE_ACCESS);
});

import { GIT_SOURCE_CONTROL_REMOTE_ACCESS } from "../src/sourceControlServerEntry.ts";
test("Source Control branch review policy validates before routes are enabled", () => {
  validateRemoteAccessPolicy("git", GIT_SOURCE_CONTROL_REMOTE_ACCESS);
});
