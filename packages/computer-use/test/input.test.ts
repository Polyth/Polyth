import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import test from "node:test";
import { fit, mappingFor } from "../src/geometry.ts";
import { decodeXwd, encodePng, resample } from "../src/image.ts";
import { describeChord, parseChord } from "../src/keys.ts";
import { xdotoolArgs, xdotoolChord, xdotoolTypeCalls } from "../src/drivers/linux.ts";
import { macKeyPress } from "../src/drivers/macos.ts";
import { windowsKeyPress } from "../src/drivers/windows.ts";

const invalid = (cause: unknown) => (cause as { code?: string }).code === "invalid-input";

test("chords parse aliases, order modifiers and keep the key last", () => {
  assert.equal(describeChord(parseChord("Shift+Ctrl+T")), "ctrl+shift+T");
  assert.equal(describeChord(parseChord("cmd+space")), "meta+space");
  assert.equal(describeChord(parseChord("Return")), "enter");
  assert.equal(describeChord(parseChord("option+PgDn")), "alt+pagedown");
  assert.equal(describeChord(parseChord("ctrl+alt")), "ctrl+alt");
  assert.equal(describeChord(parseChord("ctrl++")), "ctrl++");
  assert.equal(describeChord(parseChord("+")), "+");
  assert.throws(() => parseChord("hello"), invalid);
  assert.throws(() => parseChord("t+ctrl"), invalid);
  assert.throws(() => parseChord("ctrl+"), invalid);
  assert.throws(() => parseChord(""), invalid);
});

test("each platform maps the same chord to its own keys", () => {
  assert.equal(xdotoolChord(parseChord("ctrl+T")), "ctrl+shift+t");
  assert.equal(xdotoolChord(parseChord("cmd+/")), "super+slash");
  assert.equal(xdotoolChord(parseChord("pageup")), "Prior");
  assert.equal(xdotoolChord(parseChord("ctrl++")), "ctrl+shift+equal");

  assert.deepEqual(macKeyPress(parseChord("cmd+c")), { code: 8, flags: 1 << 20, modifierCodes: [55] });
  assert.deepEqual(macKeyPress(parseChord("enter")), { code: 36, flags: 0, modifierCodes: [] });
  assert.deepEqual(macKeyPress(parseChord("shift")), { code: -1, flags: 1 << 17, modifierCodes: [56] });

  assert.deepEqual(windowsKeyPress(parseChord("alt+f4")), { vk: 0x73, modifiers: [0x12], extended: [] });
  assert.deepEqual(windowsKeyPress(parseChord("ctrl+shift+left")), { vk: 0x25, modifiers: [0x11, 0x10], extended: [0x25] });
  assert.deepEqual(windowsKeyPress(parseChord("win+e")), { vk: 0x45, modifiers: [0x5b], extended: [0x5b] });
  assert.deepEqual(windowsKeyPress(parseChord("ctrl+;")), { vk: 0xba, modifiers: [0x11], extended: [] });
});

test("xdotool invocations hold modifiers around the action and split typed lines", () => {
  assert.deepEqual(
    xdotoolArgs({ kind: "click", at: { x: 10, y: 20 }, button: "right", count: 2, modifiers: ["ctrl", "shift"] }),
    ["keydown", "ctrl+shift", "mousemove", "10", "20", "click", "--repeat", "2", "--delay", "80", "3", "keyup", "ctrl+shift"],
  );
  assert.deepEqual(
    xdotoolArgs({ kind: "scroll", at: { x: 1, y: 2 }, dx: -2, dy: 3, modifiers: [] }),
    ["mousemove", "1", "2", "click", "--repeat", "3", "--delay", "30", "5", "click", "--repeat", "2", "--delay", "30", "6"],
  );
  assert.deepEqual(xdotoolTypeCalls("a\n\nb"), [
    ["type", "--clearmodifiers", "--delay", "12", "--", "a"],
    ["key", "--clearmodifiers", "Return"],
    ["key", "--clearmodifiers", "Return"],
    ["type", "--clearmodifiers", "--delay", "12", "--", "b"],
  ]);
  // Text that looks like an option stays text after "--".
  assert.deepEqual(xdotoolTypeCalls("--window 1"), [["type", "--clearmodifiers", "--delay", "12", "--", "--window 1"]]);
});

test("screenshots fit the model box and clicks map back to the same pixel", () => {
  assert.deepEqual(fit({ width: 2560, height: 1440 }), { width: 1280, height: 720 });
  assert.deepEqual(fit({ width: 1024, height: 768 }), { width: 1024, height: 768 });
  assert.deepEqual(fit({ width: 3024, height: 1964 }), { width: 1232, height: 800 });
  const mapping = mappingFor({ width: 2560, height: 1440 });
  assert.deepEqual(mapping.toScreen({ x: 200, y: 120 }), { x: 401, y: 241 });
  assert.deepEqual(mapping.toImage({ x: 401, y: 241 }), { x: 200, y: 120 });
  assert.deepEqual(mapping.toScreen({ x: 1279, y: 719 }), { x: 2559, y: 1439 });
  assert.throws(() => mapping.toScreen({ x: 1280, y: 0 }), invalid);
  assert.deepEqual(mapping.rectToScreen({ x: 10, y: 10, width: 100, height: 50 }), { x: 20, y: 20, width: 200, height: 100 });
  assert.deepEqual(mapping.rectToScreen({ x: 1200, y: 700, width: 500, height: 500 }), { x: 2400, y: 1400, width: 160, height: 40 });
  assert.throws(() => mapping.rectToScreen({ x: 2000, y: 0, width: 10, height: 10 }), invalid);
});

test("area resampling averages source pixels and the PNG round-trips", () => {
  // 4×2 image: left half black, right half white.
  const data = new Uint8Array(4 * 2 * 3);
  for (let y = 0; y < 2; y += 1) for (let x = 2; x < 4; x += 1) data.fill(255, (y * 4 + x) * 3, (y * 4 + x) * 3 + 3);
  const half = resample({ width: 4, height: 2, data }, { x: 0, y: 0, width: 4, height: 2 }, { width: 2, height: 1 });
  assert.deepEqual([...half.data], [0, 0, 0, 255, 255, 255]);
  const third = resample({ width: 4, height: 2, data }, { x: 1, y: 0, width: 3, height: 2 }, { width: 1, height: 1 });
  assert.deepEqual([...third.data], [170, 170, 170]);

  const png = encodePng({ width: 2, height: 1, data: new Uint8Array([10, 20, 30, 40, 50, 60]) });
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.subarray(12, 16).toString("latin1"), "IHDR");
  assert.equal(png.readUInt32BE(16), 2);
  assert.equal(png.readUInt32BE(20), 1);
  const idatLength = png.readUInt32BE(33);
  assert.equal(png.subarray(37, 41).toString("latin1"), "IDAT");
  const raw = inflateSync(png.subarray(41, 41 + idatLength));
  // Sub filter: second pixel stored as the difference from the first.
  assert.deepEqual([...raw], [1, 10, 20, 30, 30, 30, 30]);
});

test("xwd TrueColor dumps decode in either byte order", () => {
  const make = (byteOrder: number) => {
    const header = Buffer.alloc(100);
    const set = (index: number, value: number) => header.writeUInt32BE(value, index * 4);
    set(0, 100); set(1, 7); set(2, 2); set(3, 24); set(4, 2); set(5, 1);
    set(7, byteOrder); set(11, 32); set(12, 8);
    set(14, 0xff0000); set(15, 0x00ff00); set(16, 0x0000ff); set(19, 1);
    const colormap = Buffer.alloc(12);
    const pixels = Buffer.alloc(8);
    const write = (offset: number, value: number) => byteOrder === 0 ? pixels.writeUInt32LE(value, offset) : pixels.writeUInt32BE(value, offset);
    write(0, 0x112233);
    write(4, 0xaabbcc);
    return Buffer.concat([header, colormap, pixels]);
  };
  for (const order of [0, 1]) {
    const image = decodeXwd(make(order));
    assert.equal(image.width, 2);
    assert.deepEqual([...image.data], [0x11, 0x22, 0x33, 0xaa, 0xbb, 0xcc]);
  }
  assert.throws(() => decodeXwd(Buffer.alloc(20)));
});
