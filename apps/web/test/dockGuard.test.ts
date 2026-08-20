// PANE-VERIFY-01/02 unit coverage: the dock guard judges the SETTLED chat
// layout — three-valued so transient mid-render states never latch a
// promotion — and detects composer actions that lose their center hit test
// to static flow collisions while ignoring intentional transient layers
// (picker menus, autocomplete popups). DOM is duck-typed: the guard only
// touches rects, the two container selectors, contains(), and
// elementFromPoint, so plain fakes cover it under node --test.
import test from "node:test";
import assert from "node:assert/strict";
import { chatDockViability, dockGuardTargets } from "../src/workspace/dockGuard.ts";

const FLOOR = 320;

interface FakeInit {
  cls?: string;
  tag?: string;
  role?: string;
  rect?: [left: number, top: number, width: number, height: number];
  position?: string;
}

class FakeEl {
  cls: string;
  tag: string;
  role: string | null;
  rectBox: { left: number; top: number; width: number; height: number };
  position: string;
  parentElement: FakeEl | null = null;
  kids: FakeEl[] = [];
  ownerDocument!: FakeDoc;

  constructor(init: FakeInit = {}) {
    this.cls = init.cls ?? "";
    this.tag = (init.tag ?? "div").toUpperCase();
    this.role = init.role ?? null;
    const [left, top, width, height] = init.rect ?? [0, 0, 0, 0];
    this.rectBox = { left, top, width, height };
    this.position = init.position ?? "static";
  }

  add(...children: FakeEl[]): this {
    for (const c of children) {
      c.parentElement = this;
      c.setDoc(this.ownerDocument);
      this.kids.push(c);
    }
    return this;
  }

  setDoc(doc: FakeDoc): void {
    this.ownerDocument = doc;
    for (const k of this.kids) k.setDoc(doc);
  }

  getBoundingClientRect() {
    const { left, top, width, height } = this.rectBox;
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
  }

  contains(other: unknown): boolean {
    for (let el = other as FakeEl | null; el; el = el.parentElement) {
      if (el === this) return true;
    }
    return false;
  }

  matches(single: string): boolean {
    const s = single.trim();
    if (s.startsWith(".")) return this.cls.split(/\s+/).includes(s.slice(1));
    if (s === "[role=button]") return this.role === "button";
    return this.tag === s.toUpperCase();
  }

  matchesAny(selector: string): boolean {
    return selector.split(",").some((s) => this.matches(s));
  }

  *descendants(): Generator<FakeEl> {
    for (const k of this.kids) {
      yield k;
      yield* k.descendants();
    }
  }

  querySelector(selector: string): FakeEl | null {
    for (const d of this.descendants()) if (d.matchesAny(selector)) return d;
    return null;
  }

  querySelectorAll(selector: string): FakeEl[] {
    return [...this.descendants()].filter((d) => d.matchesAny(selector));
  }
}

class FakeDoc {
  root: FakeEl;
  defaultView = {
    getComputedStyle: (el: FakeEl) => ({ position: el.position }),
  };

  constructor(root: FakeEl) {
    this.root = root;
    root.setDoc(this);
  }

  /** Deepest, latest-in-DOM element whose box contains the point — enough to
   *  model both "action wins" and "later sibling paints over action". */
  elementFromPoint(x: number, y: number): FakeEl | null {
    let hit: FakeEl | null = null;
    const walk = (el: FakeEl) => {
      const r = el.getBoundingClientRect();
      const inside = r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      if (inside) hit = el;
      for (const k of el.kids) walk(k);
    };
    walk(this.root);
    return hit;
  }
}

const asEl = (el: FakeEl): Element => el as unknown as Element;

/** A settled docked chat: 450px wide, timeline, composer, two clean actions. */
function chatFixture(over: { chatWidth?: number } = {}) {
  const chatWidth = over.chatWidth ?? 450;
  const chat = new FakeEl({ cls: "workspace", rect: [0, 0, chatWidth, 900] });
  const app = new FakeEl({ cls: "app", rect: [0, 0, 1440, 900] });
  new FakeDoc(app);
  app.add(chat);
  const timeline = new FakeEl({ cls: "timeline-wrap", rect: [0, 0, chatWidth, 700] });
  const composer = new FakeEl({ cls: "composer", rect: [0, 700, chatWidth, 200] });
  const attach = new FakeEl({ tag: "button", rect: [10, 760, 32, 32] });
  const send = new FakeEl({ tag: "button", rect: [chatWidth - 90, 760, 80, 32] });
  chat.add(timeline, composer);
  composer.add(attach, send);
  return { app, chat, timeline, composer, attach, send };
}

// ---- settledness classification ----------------------------------------------

test("guard: no chat element → viable (nothing to protect)", () => {
  assert.equal(chatDockViability(null, FLOOR), "viable");
});

test("guard: zero-size chat box is pending, never a latching failure", () => {
  const chat = new FakeEl({ cls: "workspace", rect: [0, 0, 0, 0] });
  new FakeDoc(chat);
  assert.equal(chatDockViability(asEl(chat), FLOOR), "pending");
});

test("guard: chat below the floor is blocked", () => {
  const { chat } = chatFixture({ chatWidth: 300 });
  assert.equal(chatDockViability(asEl(chat), FLOOR), "blocked");
});

test("guard: a stage with no composer (empty state) is viable", () => {
  const chat = new FakeEl({ cls: "workspace", rect: [0, 0, 450, 900] });
  new FakeDoc(chat);
  chat.add(new FakeEl({ cls: "stage", rect: [0, 0, 450, 900] }));
  assert.equal(chatDockViability(asEl(chat), FLOOR), "viable");
});

test("guard: the fresh-session hero (stage + composer-hero) is judged, not failed (PANE-VERIFY-02 shape)", () => {
  // Before the repair a composer-less `.composer` lookup returned false for
  // this exact reload shape and promoted — then self-cancelled into the
  // maximum-update-depth loop.
  const chat = new FakeEl({ cls: "workspace", rect: [0, 0, 450, 900] });
  new FakeDoc(chat);
  const stage = new FakeEl({ cls: "stage", rect: [0, 0, 450, 900] });
  const hero = new FakeEl({ cls: "composer-hero", rect: [40, 300, 370, 260] });
  const send = new FakeEl({ tag: "button", rect: [330, 500, 70, 32] });
  chat.add(stage);
  stage.add(hero);
  hero.add(send);
  assert.equal(chatDockViability(asEl(chat), FLOOR), "viable");
});

test("guard: a composer without its timeline/stage is pending (partial render)", () => {
  const chat = new FakeEl({ cls: "workspace", rect: [0, 0, 450, 900] });
  new FakeDoc(chat);
  chat.add(new FakeEl({ cls: "composer", rect: [0, 700, 450, 200] }));
  assert.equal(chatDockViability(asEl(chat), FLOOR), "pending");
});

test("guard: zero-size timeline or composer boxes are pending", () => {
  const f = chatFixture();
  f.composer.rectBox = { left: 0, top: 700, width: 0, height: 0 };
  assert.equal(chatDockViability(asEl(f.chat), FLOOR), "pending");
});

// ---- composer-action protection ------------------------------------------------

test("guard: a settled chat with clean actions is viable; hidden actions are skipped", () => {
  const f = chatFixture();
  f.composer.add(new FakeEl({ tag: "button", rect: [0, 0, 0, 0] })); // hidden
  assert.equal(chatDockViability(asEl(f.chat), FLOOR), "viable");
});

test("guard: an action clipped outside Chat's rectangle is blocked", () => {
  const f = chatFixture();
  f.send.rectBox = { left: 430, top: 760, width: 80, height: 32 }; // right = 510 > 450
  assert.equal(chatDockViability(asEl(f.chat), FLOOR), "blocked");
});

test("guard: a static picker chip painting over an action's center is blocked (PANE-VERIFY-01)", () => {
  const f = chatFixture();
  // A Model-picker span in normal flow covers Attach's center — the exact
  // 1440×900 finding. Later in DOM order → elementFromPoint returns it.
  const chip = new FakeEl({ cls: "picker-label", tag: "span", rect: [0, 750, 120, 48] });
  f.composer.add(new FakeEl({ tag: "button" }).add(chip));
  assert.equal(chatDockViability(asEl(f.chat), FLOOR), "blocked");
});

test("guard: an action's own descendant winning the center is viable", () => {
  const f = chatFixture();
  f.attach.add(new FakeEl({ tag: "span", cls: "send-key", rect: [12, 762, 28, 28] }));
  assert.equal(chatDockViability(asEl(f.chat), FLOOR), "viable");
});

test("guard: an intentional positioned layer (menu/popup) over an action is NOT a dock defect", () => {
  const f = chatFixture();
  // Picker menu opens upward over the composer: absolutely positioned.
  f.composer.add(new FakeEl({ cls: "ac-popup", rect: [0, 600, 300, 220], position: "absolute" }));
  assert.equal(chatDockViability(asEl(f.chat), FLOOR), "viable");
});

test("guard: the docked pane itself covering composer actions is blocked", () => {
  const f = chatFixture();
  // A static-flow sibling outside chat paints over Send's center.
  f.app.add(new FakeEl({ cls: "rail", rect: [380, 0, 400, 900], position: "relative" }));
  assert.equal(chatDockViability(asEl(f.chat), FLOOR), "blocked");
});

// ---- observer targets ------------------------------------------------------------

test("dockGuardTargets: chat, timeline, composer, and every action — not just the width sum", () => {
  const f = chatFixture();
  const targets = dockGuardTargets(asEl(f.chat)) as unknown as FakeEl[];
  assert.deepEqual(targets, [f.chat, f.timeline, f.composer, f.attach, f.send]);
  assert.deepEqual(dockGuardTargets(null), []);
});
