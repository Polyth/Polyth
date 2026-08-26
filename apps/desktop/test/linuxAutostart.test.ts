import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildLinuxAutostartDesktopEntry,
  readLinuxAutostartEnabled,
  resolveLinuxAutostartFilePath,
  resolveLinuxLaunchExecutable,
  setLinuxAutostartEnabled,
} from "../src/linuxAutostart.ts";

test("Linux autostart prefers the stable AppImage path", () => {
  assert.equal(resolveLinuxLaunchExecutable({
    env: { APPIMAGE: "/home/user/Polyth.AppImage" },
    execPath: "/tmp/.mount_Polyth/polyth",
  }), "/home/user/Polyth.AppImage");
});

test("Linux autostart quotes paths and starts in the background", () => {
  const entry = buildLinuxAutostartDesktopEntry({
    executable: "/home/user/Polyth Desktop.AppImage",
  });
  assert.match(entry, /Exec="\/home\/user\/Polyth Desktop\.AppImage" --background/);
  assert.match(entry, /X-GNOME-Autostart-enabled=true/);
  assert.match(entry, /StartupWMClass=polyth\.desktop/);
});

test("Linux autostart is written atomically and can be removed", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "polyth-autostart-"));
  const env = { XDG_CONFIG_HOME: join(homeDir, "config"), APPIMAGE: "/opt/Polyth.AppImage" };
  const filePath = resolveLinuxAutostartFilePath({ env, homeDir });
  try {
    assert.equal(await readLinuxAutostartEnabled({ env, homeDir }), false);
    assert.equal(await setLinuxAutostartEnabled({ enabled: true, env, homeDir }), filePath);
    assert.match(await readFile(filePath, "utf8"), /Exec=\/opt\/Polyth\.AppImage --background/);
    assert.equal(await readLinuxAutostartEnabled({ env, homeDir }), true);
    await setLinuxAutostartEnabled({ enabled: false, env, homeDir });
    assert.equal(await readLinuxAutostartEnabled({ env, homeDir }), false);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
