// The header avatar: who is signed in to GitHub is asked per project, asked once
// more after an empty answer, asked again when a window comes back to the
// foreground, never lost to a later failing answer, and the picture falls back
// to the local account icon when it cannot load.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Answer = { authenticated: boolean; user: { login: string; avatarUrl: string } | null } | "error";
const asked: string[] = [];
const script: { answer: (url: string) => Answer | Promise<Answer> } = { answer: () => ({ authenticated: false, user: null }) };
(globalThis as { fetch?: unknown }).fetch = async (input: string | URL | Request) => {
  const url = String(input);
  asked.push(url);
  const answer = await script.answer(url);
  if (answer === "error") return { ok: false, status: 500, statusText: "Server Error", json: async () => ({}), text: async () => "" };
  return { ok: true, status: 200, statusText: "OK", json: async () => ({ installed: true, repo: null, ...answer }), text: async () => "" };
};

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useProfileAccount } = await import("../src/profileAccount.ts");
const { default: ProfileAvatar } = await import("../src/components/ProfileAvatar.tsx");
type Timing = import("../src/profileAccount.ts").ProfileAccountTiming;

const person = (login: string) => ({ login, avatarUrl: `https://avatars.example/${login}.png` });
const signedIn = (login: string): Answer => ({ authenticated: true, user: person(login) });
const nobody: Answer = { authenticated: false, user: null };

const clock = { now: 10_000 };
const timing: Timing = { refreshMs: 1_000, retryMs: 40, now: () => clock.now };

function Probe({ projectId }: { projectId: string | null }) {
  return createElement(ProfileAvatar, { user: useProfileAccount(projectId, timing) });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function settle() {
  await act(async () => { await sleep(0); });
}
async function until(condition: () => boolean, what: string) {
  for (let waited = 0; waited < 1_000; waited += 5) {
    if (condition()) return;
    await act(async () => { await sleep(5); });
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function mount(projectId: string | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const show = async (id: string | null) => { await act(async () => { root.render(createElement(Probe, { projectId: id })); }); await settle(); };
  await show(projectId);
  return {
    show,
    picture: () => container.querySelector("img")?.getAttribute("src") ?? null,
    icon: () => container.querySelector("svg") !== null,
    async unmount() { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

function reset() {
  asked.length = 0;
  clock.now = 10_000;
  script.answer = () => nobody;
}
const foreground = (visible = true) => {
  Object.defineProperty(document, "visibilityState", { value: visible ? "visible" : "hidden", configurable: true });
  document.dispatchEvent(new dom.Event("visibilitychange") as unknown as Event);
};
const focusWindow = () => { window.dispatchEvent(new dom.Event("focus") as unknown as Event); };

test("it asks the server passively for the project and shows the account's picture", async () => {
  reset();
  script.answer = () => signedIn("kat");
  const view = await mount("p1");
  try {
    assert.equal(asked.length, 1);
    assert.match(asked[0]!, /\/api\/github\/status\?projectId=p1&passive=true$/);
    assert.equal(view.picture(), person("kat").avatarUrl);
    assert.equal(view.icon(), false);
  } finally {
    await view.unmount();
  }
});

test("an empty first answer is asked once more, and then left alone", async () => {
  reset();
  const answers: Answer[] = [nobody, signedIn("kat")];
  script.answer = () => answers.shift() ?? nobody;
  const view = await mount("p1");
  try {
    assert.equal(view.icon(), true, "the placeholder until the account is known");
    await until(() => view.picture() === person("kat").avatarUrl, "the retried answer");
    assert.equal(asked.length, 2);

    reset();
    const quiet = await mount("p2");
    try {
      await until(() => asked.length === 2, "the one retry");
      await act(async () => { await sleep(150); });
      assert.equal(asked.length, 2, "a person without an account is not polled");
      assert.equal(quiet.icon(), true);
    } finally {
      await quiet.unmount();
    }
  } finally {
    await view.unmount();
  }
});

test("a window that returns to the foreground asks again only once its answer is old", async () => {
  reset();
  script.answer = () => signedIn("kat");
  const view = await mount("p1");
  try {
    focusWindow();
    foreground();
    await settle();
    assert.equal(asked.length, 1, "a fresh answer is not asked again");
    clock.now += 999;
    focusWindow();
    await settle();
    assert.equal(asked.length, 1);
    clock.now += 5_000;
    foreground(false);
    focusWindow();
    await settle();
    assert.equal(asked.length, 1, "nothing is asked for a window nobody sees, however old the answer");
    foreground(true);
    await settle();
    assert.equal(asked.length, 2, "it asks as soon as the window is seen again");
  } finally {
    foreground(true);
    await view.unmount();
  }
});

test("a later empty or failing answer never takes a known avatar away", async () => {
  reset();
  script.answer = () => signedIn("kat");
  const view = await mount("p1");
  try {
    for (const later of [nobody, "error" as Answer]) {
      script.answer = () => later;
      clock.now += 1_000;
      const before = asked.length;
      focusWindow();
      await until(() => asked.length === before + 1, "the refresh");
      await settle();
      assert.equal(view.picture(), person("kat").avatarUrl, `still shown after ${later === "error" ? "a server error" : "an empty answer"}`);
    }
    script.answer = () => signedIn("kat-renamed");
    clock.now += 1_000;
    focusWindow();
    await until(() => view.picture() === person("kat-renamed").avatarUrl, "a changed account to replace it");
  } finally {
    await view.unmount();
  }
});

test("the first answer for a new project replaces the avatar, and a late answer for the old one is ignored", async () => {
  reset();
  let release!: (answer: Answer) => void;
  const late = new Promise<Answer>((resolve) => { release = resolve; });
  script.answer = (url) => (url.includes("projectId=p1") ? late : signedIn("two"));
  const view = await mount("p1");
  try {
    assert.equal(view.icon(), true, "p1 has not answered yet");
    await view.show("p2");
    assert.equal(view.picture(), person("two").avatarUrl);
    release(signedIn("one"));
    await settle();
    await settle();
    assert.equal(view.picture(), person("two").avatarUrl, "the slow answer for p1 did not land on p2");

    script.answer = () => nobody;
    await view.show("p3");
    assert.equal(view.icon(), true, "a project with no account shows the placeholder, not the previous avatar");
  } finally {
    await view.unmount();
  }
});

test("without a project nothing is asked, and unmounting stops every timer and listener", async () => {
  reset();
  const none = await mount(null);
  assert.equal(asked.length, 0);
  assert.equal(none.icon(), true);
  await none.unmount();

  reset();
  const view = await mount("p1");
  assert.equal(asked.length, 1, "the empty answer schedules its one retry");
  await view.unmount();
  await sleep(150);
  focusWindow();
  foreground();
  await sleep(0);
  assert.equal(asked.length, 1, "the retry and the foreground listeners died with the component");
});

test("a picture that fails to load falls back to the account icon, and a new picture gets its own chance", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (user: { login: string; avatarUrl: string } | null) => { await act(async () => { root.render(createElement(ProfileAvatar, { user })); }); };
  try {
    await render(person("kat"));
    const image = container.querySelector("img")!;
    assert.equal(image.getAttribute("referrerpolicy"), "no-referrer");
    await act(async () => { image.dispatchEvent(new dom.Event("error") as unknown as Event); });
    assert.equal(container.querySelector("img") !== null, false, "the broken picture is gone");
    assert.equal(container.querySelector("svg") !== null, true, "the placeholder icon instead of an empty circle");
    await render(person("someone-else"));
    assert.equal(container.querySelector("img")?.getAttribute("src"), person("someone-else").avatarUrl);
    await render(null);
    assert.equal(container.querySelector("img") !== null, false);
    assert.equal(container.querySelector("svg") !== null, true);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
