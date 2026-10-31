import assert from "node:assert/strict";
import test from "node:test";
import { assertUpdaterCapability } from "../src/updaterCapability.ts";

const fileStat = { isFile: () => true };

test("Linux updates require a writable AppImage", () => {
  assert.throws(
    () => assertUpdaterCapability({ packaged: true, platform: "linux", appImagePath: "" }),
    /packaged Linux AppImage/,
  );
  assert.throws(
    () => assertUpdaterCapability({
      packaged: true,
      platform: "linux",
      appImagePath: "/opt/Polyth.AppImage",
      stat: () => fileStat,
      access: () => { throw Object.assign(new Error("readonly"), { code: "EACCES" }); },
    }),
    /not writable/,
  );
});

test("Linux updates accept a writable AppImage and other platforms", () => {
  assert.doesNotThrow(() => assertUpdaterCapability({
    packaged: true,
    platform: "linux",
    appImagePath: "/opt/Polyth.AppImage",
    stat: () => fileStat,
    access: () => {},
  }));
  assert.doesNotThrow(() => assertUpdaterCapability({
    packaged: true,
    platform: "darwin",
    appImagePath: undefined,
  }));
});
