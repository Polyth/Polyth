import test from "node:test";
import assert from "node:assert/strict";
import { railClusterBlockSize } from "../src/railClusterSize.ts";

type Box = { top: number; height: number };
type FakeStyle = Partial<Record<"display" | "position" | "paddingTop" | "paddingBottom" | "rowGap", string>>;
type Fake = {
  classList: { contains: (name: string) => boolean };
  children: Fake[];
  style: FakeStyle;
  box: Box;
  scrollHeight: number;
  clientHeight: number;
  getBoundingClientRect: () => { top: number; bottom: number; height: number };
};

function fake(box: Box, options: { className?: string; style?: FakeStyle; children?: Fake[]; scrollHeight?: number; clientHeight?: number } = {}): Fake {
  return {
    classList: { contains: (name) => name === options.className },
    children: options.children ?? [],
    style: options.style ?? {},
    box,
    scrollHeight: options.scrollHeight ?? box.height,
    clientHeight: options.clientHeight ?? box.height,
    getBoundingClientRect: () => ({ top: box.top, bottom: box.top + box.height, height: box.height }),
  };
}

function withStyles<T>(run: () => T): T {
  const previous = globalThis.getComputedStyle;
  globalThis.getComputedStyle = ((element: Fake) => ({
    display: "flex", position: "static", paddingTop: "0px", paddingBottom: "0px", rowGap: "normal", ...element.style,
  })) as unknown as typeof getComputedStyle;
  try {
    return run();
  } finally {
    globalThis.getComputedStyle = previous;
  }
}

test("the cluster height comes from natural children while the strip is stretched", () => {
  // Docked: the list stretches to 600px, but its six 32px rows (4px gap) end at 212.
  const rows = Array.from({ length: 6 }, (_, index) => fake({ top: 8 + index * 36, height: 32 }));
  const list = fake({ top: 8, height: 600 }, { className: "rail-icon-scroll", children: rows, scrollHeight: 600, clientHeight: 600 });
  const customize = fake({ top: 0, height: 0 }, { style: { display: "none" } });
  const strip = fake({ top: 0, height: 634 }, {
    children: [list, customize],
    style: { paddingTop: "8px", paddingBottom: "8px", rowGap: "8px" },
  });
  // 8 + (6×32 + 5×4) + 8 + the host's two 1px borders; hidden children add no gap.
  assert.equal(withStyles(() => railClusterBlockSize(strip as unknown as HTMLElement)), 8 + 212 + 8 + 2);
});

test("an overflowing list reports its scroll height and other in-flow children count with gaps", () => {
  const list = fake({ top: 8, height: 300 }, { className: "rail-icon-scroll", scrollHeight: 900, clientHeight: 300 });
  const widget = fake({ top: 316, height: 40 });
  const floating = fake({ top: 0, height: 99 }, { style: { position: "absolute" } });
  const strip = fake({ top: 0, height: 364 }, {
    children: [list, widget, floating],
    style: { paddingTop: "8px", paddingBottom: "8px", rowGap: "8px" },
  });
  assert.equal(withStyles(() => railClusterBlockSize(strip as unknown as HTMLElement)), 8 + 900 + 8 + 40 + 8 + 2);
});

test("an empty strip is just its padding and the host border", () => {
  const strip = fake({ top: 0, height: 16 }, { style: { paddingTop: "8px", paddingBottom: "8px" } });
  assert.equal(withStyles(() => railClusterBlockSize(strip as unknown as HTMLElement)), 18);
});
