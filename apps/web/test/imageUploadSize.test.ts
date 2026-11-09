// A heavy photo waits for a size; everything else goes up at once, and nothing
// is uploaded twice or lost when the person changes their mind.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: () => ({ matches: false, media: "", addEventListener: () => {}, removeEventListener: () => {} }),
});
URL.createObjectURL = () => "blob:photo";
URL.revokeObjectURL = () => {};

register("./tsxHooks.mjs", import.meta.url);

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const {
  ASK_IMAGE_SIZE_ABOVE_BYTES,
  formatImageBytes,
  imageSizeOptions,
  isResizableImage,
  parseImageUploadPreference,
  presetKeepsOriginal,
  recommendedImageSize,
  reducedImageName,
  shouldAskImageSize,
} = await import("../src/imageUploadSize.ts");
const { default: ImageSizePrompt, useImageSizeChoice } = await import("../src/components/ImageSizePrompt.tsx");
const { getUiSettings, parseUiSettings, setUiSettings, UI_DEFAULTS } = await import("../src/uiPrefs.ts");

const MB = 1024 * 1024;

function photo(name: string, size: number, type = "image/jpeg"): File {
  return new File([new Uint8Array(size)], name, { type });
}

function copyOf(file: File, size: number): File {
  return new File([new Uint8Array(size)], file.name, { type: "image/jpeg" });
}

test("only a heavy photo in a redrawable format is worth asking about", () => {
  assert.equal(shouldAskImageSize(photo("big.jpg", 3 * MB)), true);
  assert.equal(shouldAskImageSize(photo("light.jpg", ASK_IMAGE_SIZE_ABOVE_BYTES)), false);
  assert.equal(shouldAskImageSize(photo("anim.gif", 3 * MB, "image/gif")), false, "a redraw would stop the animation");
  assert.equal(shouldAskImageSize(photo("logo.svg", 3 * MB, "image/svg+xml")), false);
  assert.equal(shouldAskImageSize(photo("notes.pdf", 3 * MB, "application/pdf")), false);
  assert.equal(isResizableImage(photo("shot.PNG", 10, "IMAGE/PNG")), true);
});

test("a light screenshot within the preset stays sharp; a heavy one is still reduced", () => {
  assert.equal(presetKeepsOriginal({ size: 200_000 }, 900, "small"), true);
  assert.equal(presetKeepsOriginal({ size: 200_000 }, 3000, "small"), false, "over the edge");
  assert.equal(presetKeepsOriginal({ size: 3 * MB }, 900, "small"), false, "over the weight");
});

test("a reduced copy is named for what it now is", () => {
  assert.equal(reducedImageName("IMG_1234.HEIC", "image/jpeg"), "IMG_1234.jpg");
  assert.equal(reducedImageName("logo.final.png", "image/png"), "logo.final.png");
  assert.equal(reducedImageName("", "image/jpeg"), "photo.jpg");
});

test("the setting defaults to asking and refuses unknown values", () => {
  assert.equal(UI_DEFAULTS.imageUploadSize, "ask");
  assert.equal(parseImageUploadPreference("medium"), "medium");
  assert.equal(parseImageUploadPreference("gigantic"), "ask");
  assert.equal(parseUiSettings(JSON.stringify({ imageUploadSize: "small" })).imageUploadSize, "small");
  assert.equal(parseUiSettings(JSON.stringify({ imageUploadSize: 7 })).imageUploadSize, "ask");
});

test("before a photo is measured every size is on offer without a guess", () => {
  const options = imageSizeOptions([{ file: { size: 8 * MB } }]);
  assert.deepEqual(options.map((option) => option.id), ["small", "medium", "large", "original"]);
  assert.deepEqual(options.map((option) => option.bytes), [null, null, null, 8 * MB]);
});

test("a size that would change nothing disappears", () => {
  const options = imageSizeOptions([{
    file: { size: 2 * MB },
    longEdge: 1200,
    variants: {
      small: { size: 300_000 } as File,
      medium: { size: 500_000 } as File,
      large: { size: 600_000 } as File,
    },
  }]);
  assert.deepEqual(options.map((option) => option.id), ["small", "medium", "original"]);
  assert.equal(options[1]!.edge, 1200, "medium cannot scale the photo up");
  assert.equal(options[2]!.edge, 1200);
  assert.equal(options[0]!.edge, 1024);
  assert.equal(recommendedImageSize(options), "medium");
});

test("a preset that saves nothing is not offered, and the recommendation moves", () => {
  const file = { size: 2 * MB } as File;
  const options = imageSizeOptions([{
    file,
    longEdge: 1000,
    variants: { small: { size: 400_000 } as File, medium: file, large: file },
  }]);
  assert.deepEqual(options.map((option) => option.id), ["small", "original"]);
  assert.equal(recommendedImageSize(options), "small");
});

test("a batch extrapolates from what is measured, then states the exact total", () => {
  const measuredVariants = {
    small: { size: 100 } as File,
    medium: { size: 200 } as File,
    large: { size: 300 } as File,
  };
  const partial = imageSizeOptions([
    { file: { size: 2 * MB }, longEdge: 4000, variants: measuredVariants },
    { file: { size: 2 * MB } },
  ]);
  assert.equal(partial[1]!.bytes, 400);
  assert.equal(partial[1]!.approximate, true);
  assert.equal(partial[3]!.approximate, false, "the original's total is simply known");
  const whole = imageSizeOptions([
    { file: { size: 2 * MB }, longEdge: 4000, variants: measuredVariants },
    { file: { size: 2 * MB }, longEdge: 3000, variants: measuredVariants },
  ]);
  assert.equal(whole[1]!.bytes, 400);
  assert.equal(whole[1]!.approximate, false);
  assert.equal(whole[3]!.edge, null, "a batch has no one edge");
});

test("sizes read in the person's language", () => {
  assert.match(formatImageBytes(8_200_000, "en"), /^8\.2\sMB$/);
  assert.match(formatImageBytes(340_000, "en"), /^340\skB$/);
  assert.match(formatImageBytes(8_200_000, "uk"), /^8,2\sМБ$/);
});

interface Harness {
  choice: ReturnType<typeof useImageSizeChoice>;
  host: HTMLElement;
  unmount(): void;
  rerender(scopeKey: string): void;
}

function mount(encode: Parameters<typeof useImageSizeChoice>[0]["encode"], onScopeChanged: () => void = () => {}): Harness {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const harness = { host } as unknown as Harness;
  const View = ({ scopeKey }: { scopeKey: string }) => {
    harness.choice = useImageSizeChoice({ scopeKey, encode, onScopeChanged });
    return createElement(ImageSizePrompt, { choice: harness.choice });
  };
  harness.rerender = (scopeKey) => { act(() => { root.render(createElement(View, { scopeKey })); }); };
  harness.unmount = () => { act(() => { root.unmount(); }); host.remove(); };
  harness.rerender("draft-a");
  return harness;
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await act(async () => { await Promise.resolve(); });
}

const halving: NonNullable<Parameters<typeof useImageSizeChoice>[0]["encode"]> = async (file, presets) => ({
  longEdge: 4000,
  variants: Object.fromEntries(presets.map((preset) => [preset, copyOf(file, { small: 1000, medium: 2000, large: 3000 }[preset])])),
});

function buttonLabelled(host: HTMLElement, text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
  assert.ok(button, `no button "${text}"`);
  return button as HTMLButtonElement;
}

test("a heavy photo waits for the answer while the rest of the batch goes up", async () => {
  setUiSettings({ imageUploadSize: "ask" });
  const harness = mount(halving);
  const committed: Array<[string, number]> = [];
  const commit = (original: File) => (chosen: File) => { committed.push([original.name, chosen.size]); };
  const heavy = photo("heavy.jpg", 3 * MB);
  const note = photo("note.txt", 10, "text/plain");
  const light = photo("light.jpg", 1000);
  act(() => {
    harness.choice.offer([heavy, note, light].map((file) => ({ file, commit: commit(file) })));
  });
  await settle();
  assert.deepEqual(committed, [["note.txt", 10], ["light.jpg", 1000]]);
  assert.equal(harness.choice.pending.length, 1);
  assert.ok(harness.host.querySelector(".image-size-prompt"));

  act(() => { buttonLabelled(harness.host, "Medium").click(); });
  await settle();
  assert.deepEqual(committed.at(-1), ["heavy.jpg", 2000]);
  assert.equal(harness.host.querySelector(".image-size-prompt"), null);
  assert.equal(getUiSettings().imageUploadSize, "ask", "one answer is not a standing choice");
  harness.unmount();
});

test("Original sends the very same file, and Cancel sends nothing", async () => {
  setUiSettings({ imageUploadSize: "ask" });
  const harness = mount(halving);
  const sent: File[] = [];
  const first = photo("first.jpg", 2 * MB);
  act(() => { harness.choice.offer([{ file: first, commit: (chosen) => { sent.push(chosen); } }]); });
  await settle();
  act(() => { buttonLabelled(harness.host, "Original").click(); });
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0], first);

  act(() => { harness.choice.offer([{ file: photo("second.jpg", 2 * MB), commit: (chosen) => { sent.push(chosen); } }]); });
  await settle();
  act(() => { (harness.host.querySelector(".image-size-prompt-head button") as HTMLButtonElement).click(); });
  await settle();
  assert.equal(sent.length, 1, "cancelled photo was not uploaded");
  assert.equal(harness.choice.pending.length, 0);
  harness.unmount();
});

test("remembering an answer stops the question, and the size still applies", async () => {
  setUiSettings({ imageUploadSize: "ask" });
  const harness = mount(halving);
  const sizes: number[] = [];
  act(() => { harness.choice.offer([{ file: photo("a.jpg", 2 * MB), commit: (chosen) => { sizes.push(chosen.size); } }]); });
  await settle();
  act(() => { (harness.host.querySelector(".image-size-prompt-remember input") as HTMLInputElement).click(); });
  act(() => { buttonLabelled(harness.host, "Small").click(); });
  await settle();
  assert.deepEqual(sizes, [1000]);
  assert.equal(getUiSettings().imageUploadSize, "small");

  act(() => { harness.choice.offer([{ file: photo("b.jpg", 2 * MB), commit: (chosen) => { sizes.push(chosen.size); } }]); });
  await settle();
  assert.equal(harness.host.querySelector(".image-size-prompt"), null);
  assert.deepEqual(sizes, [1000, 1000]);
  setUiSettings({ imageUploadSize: "ask" });
  harness.unmount();
});

test("the Original setting never touches a photo", async () => {
  setUiSettings({ imageUploadSize: "original" });
  let encoded = 0;
  const harness = mount(async (file, presets) => { encoded += 1; return halving(file, presets); });
  const file = photo("a.jpg", 5 * MB);
  const sent: File[] = [];
  act(() => { harness.choice.offer([{ file, commit: (chosen) => { sent.push(chosen); } }]); });
  await settle();
  assert.equal(encoded, 0);
  assert.equal(sent[0], file);
  setUiSettings({ imageUploadSize: "ask" });
  harness.unmount();
});

test("a photo the browser cannot decode goes up unchanged instead of waiting forever", async () => {
  setUiSettings({ imageUploadSize: "ask" });
  const harness = mount(async (file, presets) => ({
    longEdge: 0,
    variants: Object.fromEntries(presets.map((preset) => [preset, file])),
  }));
  const file = photo("a.heic", 5 * MB, "image/heic");
  const sent: File[] = [];
  act(() => { harness.choice.offer([{ file, commit: (chosen) => { sent.push(chosen); } }]); });
  await settle();
  assert.equal(sent[0], file);
  assert.equal(harness.host.querySelector(".image-size-prompt"), null);
  harness.unmount();
});

test("an answer given while sizes are still being measured is honoured", async () => {
  setUiSettings({ imageUploadSize: "ask" });
  let release = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const harness = mount(async (file, presets) => {
    if (presets.length > 1) await blocked;
    return halving(file, presets);
  });
  const sizes: number[] = [];
  act(() => { harness.choice.offer([{ file: photo("a.jpg", 2 * MB), commit: (chosen) => { sizes.push(chosen.size); } }]); });
  await settle();
  act(() => { buttonLabelled(harness.host, "Large").click(); });
  await settle();
  assert.deepEqual(sizes, [3000]);
  release();
  await settle();
  assert.deepEqual(sizes, [3000], "the late measurement does not send it again");
  harness.unmount();
});

test("moving to another draft drops the question and says so", async () => {
  setUiSettings({ imageUploadSize: "ask" });
  let told = 0;
  const harness = mount(halving, () => { told += 1; });
  const sent: File[] = [];
  act(() => { harness.choice.offer([{ file: photo("a.jpg", 2 * MB), commit: (chosen) => { sent.push(chosen); } }]); });
  await settle();
  harness.rerender("draft-b");
  await settle();
  assert.equal(told, 1);
  assert.equal(sent.length, 0);
  assert.equal(harness.choice.pending.length, 0);
  harness.rerender("draft-c");
  assert.equal(told, 1, "nothing was waiting the second time");
  harness.unmount();
});
