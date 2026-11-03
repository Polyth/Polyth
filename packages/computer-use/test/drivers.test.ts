import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { createLinuxDriver } from "../src/drivers/linux.ts";
import { createMacDriver } from "../src/drivers/macos.ts";
import { createWindowsDriver } from "../src/drivers/windows.ts";
import { detectDriver } from "../src/drivers/index.ts";
import { ComputerUseError } from "../src/errors.ts";
import type { CommandRunner, RunOptions } from "../src/process.ts";

interface Call { command: string; args: readonly string[]; options: RunOptions }

const recorder = (answer: (call: Call) => Buffer | Error | Promise<Buffer | Error>) => {
  const calls: Call[] = [];
  const run: CommandRunner = async (command, args, options = {}) => {
    const call = { command, args, options };
    calls.push(call);
    const result = await answer(call);
    if (result instanceof Error) throw result;
    return { stdout: result, stderr: "" };
  };
  return { calls, run };
};

const code = (expected: string) => (cause: unknown) => (cause as { code?: string }).code === expected;
const MALICIOUS = "'); do shell script \"rm -rf ~\"; ('";

test("the driver follows the server's own platform and display", () => {
  assert.equal(detectDriver("darwin", {})?.platform, "macos");
  assert.equal(detectDriver("win32", {})?.platform, "windows");
  assert.equal(detectDriver("linux", { DISPLAY: ":0" })?.platform, "linux-x11");
  assert.equal(detectDriver("linux", {}), undefined);
  assert.equal(detectDriver("freebsd", { DISPLAY: ":0" }), undefined);
});

test("macOS requests travel in the environment, never in script source", async () => {
  const { calls, run } = recorder(() => Buffer.from(JSON.stringify({ screen: { width: 1512, height: 982 }, cursor: { x: 1, y: 2 } })));
  const driver = createMacDriver({ run, env: {} });
  const state = await driver.perform({ kind: "type", text: MALICIOUS });
  assert.deepEqual(state.screen, { width: 1512, height: 982 });
  const call = calls[0]!;
  assert.equal(call.command, "osascript");
  assert.deepEqual(call.args, ["-l", "JavaScript", "-"]);
  assert.equal(call.options.input!.includes(MALICIOUS), false);
  assert.deepEqual(JSON.parse(call.options.env!.POLYTH_COMPUTER_REQUEST!), { op: "perform", step: { kind: "type", text: MALICIOUS } });

  await driver.perform({ kind: "key", chord: { modifiers: ["meta"], key: { kind: "char", char: "v" } }, repeat: 2 });
  assert.deepEqual(JSON.parse(calls[1]!.options.env!.POLYTH_COMPUTER_REQUEST!).step, { kind: "key", repeat: 2, code: 9, flags: 1 << 20, modifierCodes: [55] });
});

test("macOS script failures keep their code and message", async () => {
  const raised = new ComputerUseError("driver-failed", "osascript failed (exit 1): execution error: Error: {\"code\":\"permission-required\",\"message\":\"Turn Polyth on in Accessibility\"} (-2700)");
  const driver = createMacDriver({ run: recorder(() => raised).run, env: {} });
  await assert.rejects(driver.perform({ kind: "move", to: { x: 1, y: 1 } }), (error: unknown) =>
    code("permission-required")(error) && (error as Error).message === "Turn Polyth on in Accessibility");
  const probe = await driver.probe();
  assert.equal(probe.ok, false);
  assert.match(probe.reason!, /Accessibility/);
});

test("macOS captures the main display and scales it with sips", async () => {
  const { calls, run } = recorder(async (call) => {
    if (call.command === "osascript") return Buffer.from(JSON.stringify({ screen: { width: 1512, height: 982 }, cursor: { x: 0, y: 0 } }));
    if (call.command === "sips") await writeFile(String(call.args.at(-1)), "scaled");
    return Buffer.alloc(0);
  });
  const shot = await createMacDriver({ run, env: {} }).capture({ output: { width: 1232, height: 800 } });
  assert.equal(shot.png.toString(), "scaled");
  assert.equal(JSON.parse(calls[0]!.options.env!.POLYTH_COMPUTER_REQUEST!).capture, true);
  assert.deepEqual(calls[1]!.args.slice(0, 4), ["-x", "-t", "png", "-m"]);
  assert.deepEqual(calls[2]!.args.slice(0, 3), ["-z", "800", "1232"]);
});

test("Windows requests travel in the environment and helper errors surface", async () => {
  const { calls, run } = recorder((call) => {
    const request = JSON.parse(call.options.env!.POLYTH_COMPUTER_REQUEST!);
    if (request.op === "focus") return new ComputerUseError("driver-failed", "powershell.exe failed (exit 3): POLYTH_ERROR:not-found");
    if (request.op === "windows") return Buffer.from("");
    return Buffer.from(JSON.stringify({ screen: { width: 3840, height: 2160 }, cursor: { x: 5, y: 5 } }));
  });
  const driver = createWindowsDriver({ run, env: {} });
  await driver.perform({ kind: "type", text: MALICIOUS });
  const call = calls[0]!;
  assert.equal(call.command, "powershell.exe");
  assert.equal(call.args.includes("-EncodedCommand"), true);
  const script = Buffer.from(String(call.args.at(-1)), "base64").toString("utf16le");
  assert.equal(script.includes(MALICIOUS), false);
  assert.match(script, /\$env:POLYTH_COMPUTER_REQUEST/);
  assert.match(call.options.env!.POLYTH_COMPUTER_CSHARP!, /class PolythComputer/);

  await driver.perform({ kind: "click", at: { x: 1, y: 1 }, button: "left", count: 1, modifiers: ["shift"] });
  assert.deepEqual(JSON.parse(calls[1]!.options.env!.POLYTH_COMPUTER_REQUEST!).step.modifierKeys, [0x10]);
  assert.deepEqual(await driver.windows(), []);
  await assert.rejects(driver.focus("123"), code("not-found"));
  await assert.rejects(driver.focus("1; calc"), code("invalid-input"));
});

test("Linux refuses Wayland and explains missing helpers", async () => {
  const wayland = await createLinuxDriver({ env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" } }).probe();
  assert.equal(wayland.ok, false);
  assert.match(wayland.reason!, /Wayland/);
  const missing = await createLinuxDriver({
    env: { DISPLAY: ":0" },
    run: recorder(() => new ComputerUseError("missing-helper", "xdotool is not installed")).run,
  }).probe();
  assert.equal(missing.ok, false);
  assert.match(missing.reason!, /apt install xdotool x11-apps/);
});
