import test from "node:test";
import assert from "node:assert/strict";
import { cliLauncherPlan, openPathFromArgv } from "../src/cliInstall.ts";

test("POSIX launcher runs the bundled CLI with the app binary in Node mode", () => {
  const plan = cliLauncherPlan({
    platform: "linux", executable: "/tmp/.mount_x/polyth", appImage: "/home/me/Apps/Polyth.AppImage",
    cliScript: "/tmp/.mount_x/resources/cli/polyth.cjs", home: "/home/me",
  });
  assert.equal(plan.path, "/home/me/.local/bin/polyth");
  assert.equal(plan.mode, 0o755);
  assert.match(plan.content, /^#!\/bin\/sh\n/);
  // The AppImage file is stable; its mount point is not.
  assert.match(plan.content, /POLYTH_DESKTOP_EXECUTABLE='\/home\/me\/Apps\/Polyth\.AppImage'/);
  assert.match(plan.content, /ELECTRON_RUN_AS_NODE=1 exec "\$POLYTH_DESKTOP_EXECUTABLE" '\/tmp\/\.mount_x\/resources\/cli\/polyth\.cjs' "\$@"/);
  const quoted = cliLauncherPlan({ platform: "darwin", executable: "/Applications/Po'lyth.app/x", cliScript: "/c", home: "/Users/me" });
  assert.match(quoted.content, /'\/Applications\/Po'\\''lyth\.app\/x'/);
  assert.match(quoted.pathHint, /zshrc/);
});

test("Windows launcher is a user-owned .cmd under LocalAppData", () => {
  const plan = cliLauncherPlan({
    platform: "win32", executable: "C:\\Program Files\\Polyth\\Polyth.exe", cliScript: "C:\\Program Files\\Polyth\\resources\\cli\\polyth.cjs",
    home: "C:\\Users\\me", localAppData: "C:\\Users\\me\\AppData\\Local",
  });
  assert.match(plan.path, /AppData[\\/]Local[\\/]Polyth[\\/]bin[\\/]polyth\.cmd$/);
  assert.match(plan.content, /set ELECTRON_RUN_AS_NODE=1\r\n/);
  assert.match(plan.content, /"C:\\Program Files\\Polyth\\Polyth\.exe" "C:\\Program Files\\Polyth\\resources\\cli\\polyth\.cjs" %\*/);
});

test("--polyth-open accepts only in-app session/project paths", () => {
  assert.equal(openPathFromArgv(["polyth", "--polyth-open=/p/abc/s/1234-5678"]), "/p/abc/s/1234-5678");
  assert.equal(openPathFromArgv(["--polyth-open=/"]), "/");
  assert.equal(openPathFromArgv(["--polyth-open=/p/abc"]), "/p/abc");
  for (const bad of ["//evil.example", "/p/a/s/b?x=1", "https://evil.example", "/settings", "/p/../x/s/y", "/p/a b"]) {
    assert.equal(openPathFromArgv([`--polyth-open=${bad}`]), null, bad);
  }
  assert.equal(openPathFromArgv(["--other"]), null);
});
