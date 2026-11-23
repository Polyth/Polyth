// A native Desktop page through the browser service: the session names the
// view the local window shows live, follows the size that window gives it,
// and a person's page keeps its sign-ins in that person's profile only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrowserService, createFakeDriver, type BrowserDriver, type DriverPage, type FakeWeb } from "../src/index.ts";
import { EDGE_TRIM, overlayOver, probePoints, stageUnobstructed, nativeWebViewsBridge, NATIVE_PAGE_UNDER, trimEdges } from "../widgets/nativePage.ts";

const HOME = "http://127.0.0.1:5173/";
const web = (): FakeWeb => ({ pages: { [HOME]: { title: "App", text: "welcome home" } } });

/** The fake engine dressed as a native one: a view id and a shown signal. */
function nativeFake(): { driver: BrowserDriver; opened: Array<{ profileDir?: string }>; show: (state: { shown: boolean; width?: number; height?: number }) => void } {
  const base = createFakeDriver(web());
  const opened: Array<{ profileDir?: string }> = [];
  const listeners = new Set<(state: { shown: boolean; width?: number; height?: number }) => void>();
  const driver: BrowserDriver = {
    engine: "chromium",
    native: true,
    async open(opts) {
      opened.push({ ...(opts.profileDir ? { profileDir: opts.profileDir } : {}) });
      const page = await base.open(opts);
      const native: DriverPage = Object.assign(Object.create(page) as DriverPage, {
        nativeViewId: `view-${opened.length}`,
        onNativeShown(cb: (state: { shown: boolean; width?: number; height?: number }) => void) {
          listeners.add(cb);
          return () => { listeners.delete(cb); };
        },
      });
      return native;
    },
    close: () => base.close(),
  };
  return { driver, opened, show: (state) => { for (const cb of listeners) cb(state); } };
}

const serviceWith = (driver: BrowserDriver, profileDirFor?: (owner: { projectId: string; ownerUserId: string }) => Promise<string | undefined>) =>
  createBrowserService({
    driver,
    allowedOrigins: () => ["http://127.0.0.1:5173"],
    resolve: async () => ["93.184.216.34"],
    ...(profileDirFor ? { profileDirFor } : {}),
  });

test("a native page names its view and takes the size the window shows it at", async () => {
  const fake = nativeFake();
  const svc = serviceWith(fake.driver);
  const session = await svc.create({ projectId: "p1", url: HOME, actor: "agent" });
  assert.equal(session.nativeViewId, "view-1");
  assert.equal(session.viewportMode, "custom");
  fake.show({ shown: true, width: 913, height: 611 });
  const shown = svc.get(session.id);
  assert.deepEqual([shown?.viewport.width, shown?.viewport.height], [913, 611]);
  assert.equal(shown?.viewportMode, "responsive");
  // Stepping back keeps the size the page has.
  fake.show({ shown: false });
  assert.equal(svc.get(session.id)?.viewport.width, 913);
  await svc.closeAll();
});

test("a person's native page opens in their own profile; server work keeps nothing", async () => {
  const fake = nativeFake();
  const asked: Array<{ projectId: string; ownerUserId: string }> = [];
  const svc = serviceWith(fake.driver, async (owner) => {
    asked.push(owner);
    return `/data/spaces/s1/packages/browser/profiles/${owner.ownerUserId}`;
  });
  await svc.create({ projectId: "p1", ownerUserId: "alice" });
  await svc.create({ projectId: "p1" });
  assert.deepEqual(asked, [{ projectId: "p1", ownerUserId: "alice" }]);
  assert.deepEqual(fake.opened, [{ profileDir: "/data/spaces/s1/packages/browser/profiles/alice" }, {}]);
  await svc.closeAll();
});

test("an engine without profiles is never asked for one", async () => {
  let asked = 0;
  const svc = serviceWith(createFakeDriver(web()), async () => { asked += 1; return "/x"; });
  const session = await svc.create({ projectId: "p1", ownerUserId: "alice" });
  assert.equal(asked, 0);
  assert.equal(session.nativeViewId, undefined);
  await svc.closeAll();
});

test("the live page shows only where the window shows the stage itself", () => {
  const rect = { x: 100, y: 50, width: 400, height: 300 };
  const points = probePoints(rect);
  assert.equal(points.length, 36);
  for (const point of points) {
    assert.ok(point.x >= rect.x && point.x < rect.x + rect.width);
    assert.ok(point.y >= rect.y && point.y < rect.y + rect.height);
  }
  const under = { closest: (selector: string) => (selector === `[${NATIVE_PAGE_UNDER}]` ? shot : null) } as unknown as Element;
  const shot = { closest: () => shot } as unknown as Element;
  const stage = { contains: (node: unknown) => node === shot || node === under } as unknown as Element;
  const menu = { closest: () => null } as unknown as Element;
  const card = { closest: () => null } as unknown as Element;
  assert.equal(stageUnobstructed(stage, rect, { elementFromPoint: () => under }), true);
  // A menu over one corner, or our own card inside the stage, steps it back.
  assert.equal(stageUnobstructed(stage, rect, { elementFromPoint: (x, y) => (x < 110 && y < 60 ? menu : under) }), false);
  assert.equal(stageUnobstructed(stage, rect, { elementFromPoint: (x, y) => (x > 250 && x < 350 && y > 150 && y < 250 ? card : under) }), false);
  assert.equal(stageUnobstructed(stage, rect, { elementFromPoint: () => null }), false);
});

test("an open menu over any part of the stage steps the page back, even between probe points", () => {
  const rect = { x: 100, y: 50, width: 400, height: 300 };
  const stage = { contains: () => false } as unknown as Element;
  const layer = (box: { left: number; top: number; right: number; bottom: number }) => ({
    closest: () => null,
    contains: () => false,
    getBoundingClientRect: () => ({ ...box, width: box.right - box.left, height: box.bottom - box.top }),
  }) as unknown as Element;
  // A menu hanging into the top-right corner, as the browser's More menu does.
  const menu = layer({ left: 380, top: 40, right: 490, bottom: 200 });
  const elsewhere = layer({ left: 600, top: 40, right: 700, bottom: 200 });
  const hidden = layer({ left: 0, top: 0, right: 0, bottom: 0 });
  const doc = (layers: Element[]) => ({ querySelectorAll: () => layers as unknown as NodeListOf<Element> }) as Pick<Document, "querySelectorAll">;
  assert.equal(overlayOver(stage, rect, doc([menu])), true);
  assert.equal(overlayOver(stage, rect, doc([elsewhere, hidden])), false);
  // The browser's own package window is a dialog that holds the stage.
  const ownWindow = Object.assign(layer({ left: 0, top: 0, right: 900, bottom: 700 }), { contains: (node: unknown) => node === stage }) as unknown as Element;
  assert.equal(overlayOver(stage, rect, doc([ownWindow])), false);
});

test("the page stays off an edge our window chrome overlaps, so a resize grip keeps working", () => {
  const rect = { x: 100, y: 50, width: 400, height: 300 };
  const shot = { closest: () => shot } as unknown as Element;
  const grip = { closest: () => null } as unknown as Element;
  const stage = { contains: (node: unknown) => node === shot } as unknown as Element;
  // A grip 6 px wide over the stage's left edge (as a package window has).
  const doc = { elementFromPoint: (x: number) => (x < 106 ? grip : shot) };
  const page = trimEdges(stage, rect, doc);
  assert.deepEqual(page, { x: 100 + EDGE_TRIM, y: 50, width: 400 - EDGE_TRIM, height: 300 });
  assert.equal(stageUnobstructed(stage, page, doc), true);
  assert.deepEqual(trimEdges(stage, rect, { elementFromPoint: () => shot }), rect);
});

test("only a Desktop window on this computer's own server may place pages", () => {
  const place = async () => {};
  assert.ok(nativeWebViewsBridge({ polythDesktop: { surface: "local", webViews: { place } } }));
  assert.equal(nativeWebViewsBridge({ polythDesktop: { surface: "remote", webViews: { place } } }), null);
  assert.equal(nativeWebViewsBridge({ polythDesktop: { surface: "local" } }), null);
  assert.equal(nativeWebViewsBridge({}), null);
});
