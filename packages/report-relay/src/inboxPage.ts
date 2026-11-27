// The team's inbox page, `GET /inbox`: one self-contained document that reads
// and triages feedback through the token-guarded `/v1/inbox` API. The page
// holds no data and no secret; the token lives in the tab's sessionStorage
// only. Feedback text is untrusted, so the script builds every node with
// `textContent`, and the CSP allows only this exact script and style (by
// hash), same-origin fetches and blob screenshots.

import { createHash } from "node:crypto";

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f6f8;--panel:#fff;--ink:#16171a;--soft:#6b6f78;--line:#e4e5ea;--accent:#4f6bed;--accent-ink:#fff;
--bug:#d8434b;--idea:#3c8be0;--pain:#d98a1c;--praise:#2f9e63;--radius:12px;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#111215;--panel:#1a1b20;--ink:#ececf0;--soft:#9a9ea8;--line:#2a2c33;--accent:#7088ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink)}
button,select,textarea,input{font:inherit;color:inherit}
button{cursor:pointer;border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:6px 12px}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
button:disabled{opacity:.5;cursor:default}
select,input,textarea{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 10px}
.hidden{display:none!important}
#login{min-height:100vh;display:grid;place-items:center}
#login form{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:28px;width:min(360px,90vw);display:grid;gap:12px}
#login h1{margin:0;font-size:18px}#login p{margin:0;color:var(--soft)}
.error{color:var(--bug);min-height:1.2em}
header{display:flex;gap:16px;align-items:center;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:1}
header h1{font-size:16px;margin:0}header .grow{flex:1}
.stats{display:flex;gap:10px;flex-wrap:wrap;padding:16px 20px 0}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:10px 14px;min-width:96px}
.stat b{display:block;font-size:20px}.stat span{color:var(--soft);font-size:12px}
.filters{display:flex;gap:8px;flex-wrap:wrap;padding:14px 20px}
main{display:grid;grid-template-columns:minmax(280px,420px) 1fr;gap:16px;padding:0 20px 20px;align-items:start}
@media (max-width:820px){main{grid-template-columns:1fr}}
#list{display:grid;gap:8px}
.item{text-align:left;display:grid;gap:4px;padding:12px 14px;border-radius:var(--radius);width:100%}
.item[aria-current=true]{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.item .meta{display:flex;gap:6px;align-items:center;color:var(--soft);font-size:12px}
.item .text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.badge{display:inline-block;border-radius:999px;padding:1px 8px;font-size:12px;font-weight:600;border:1px solid var(--line)}
.kind-bug{color:var(--bug)}.kind-idea{color:var(--idea)}.kind-pain{color:var(--pain)}.kind-praise{color:var(--praise)}
#detail{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:20px;display:grid;gap:14px;position:sticky;top:72px;max-height:calc(100vh - 92px);overflow:auto}
#detail h2{margin:0;font-size:16px;display:flex;gap:8px;align-items:center}
.body{white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0}dt{color:var(--soft)}dd{margin:0;overflow-wrap:anywhere}
.shot{max-width:100%;max-height:60vh;object-fit:contain;border-radius:8px;border:1px solid var(--line)}
pre{margin:0;max-height:320px;overflow:auto;background:var(--bg);border-radius:8px;padding:10px;font-size:12px}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
textarea{width:100%;min-height:72px;resize:vertical}
.empty{color:var(--soft);padding:24px;text-align:center}
.pager{display:flex;gap:8px;align-items:center;justify-content:center;color:var(--soft)}
#keys{padding:16px 20px;display:grid;gap:16px;max-width:1100px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px;display:grid;gap:10px}
.card h2{margin:0;font-size:15px}.card p{margin:0;color:var(--soft)}
#key-form{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.secret{display:flex;gap:8px;align-items:center}.secret input{flex:1;font-family:ui-monospace,monospace;font-size:13px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 10px;border-top:1px solid var(--line);vertical-align:top}
th{color:var(--soft);font-weight:500;font-size:12px;border-top:0}
.addr{font-family:ui-monospace,monospace;font-size:12px}.addr span{color:var(--soft);font-family:system-ui,sans-serif}
.revoked{color:var(--soft)}
`;

const SCRIPT = `
"use strict";
const KINDS = ["bug","idea","pain","praise"];
const STATUSES = ["new","seen","planned","done","dropped","keep"];
const ROLES = ["lawyer","accountant","developer","researcher","designer","manager","student","other"];
const PAGE = 50;
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
};
let token = sessionStorage.getItem("inbox-token") || "";
let offset = 0;
let selected = null;
let shotUrl = null;
let me = null;

async function api(path, init = {}) {
  const response = await fetch(path, { ...init, cache: "no-store", headers: { ...(init.headers || {}), authorization: "Bearer " + token } });
  if (response.status === 401 || response.status === 429) {
    signOut(response.status === 429 ? "Too many wrong tokens. Wait 10 minutes." : "Wrong token.");
    throw new Error("auth");
  }
  if (!response.ok) throw new Error(String(response.status));
  return response;
}

function signOut(message) {
  token = "";
  sessionStorage.removeItem("inbox-token");
  $("new-token").value = "";
  $("new-key").classList.add("hidden");
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
  $("login-error").textContent = message || "";
}

function fill(select, values, all) {
  select.append(el("option", { value: "", text: all }));
  for (const value of values) select.append(el("option", { value, text: value }));
}

function query() {
  const params = new URLSearchParams();
  for (const name of ["kind","status","role","days"]) { const value = $(name).value; if (value) params.set(name, value); }
  return params;
}

const when = (ms) => new Date(ms).toLocaleString();

async function loadSummary() {
  const params = new URLSearchParams();
  if ($("days").value) params.set("days", $("days").value);
  const summary = await (await api("/v1/inbox/summary?" + params)).json();
  const stats = $("stats");
  stats.replaceChildren();
  const stat = (label, value) => stats.append(el("div", { class: "stat" }, el("b", { text: String(value) }), el("span", { text: label })));
  stat("total", summary.total);
  stat("people", summary.installs);
  stat("new", summary.byStatus.new || 0);
  for (const kind of KINDS) stat(kind, summary.byKind[kind] || 0);
}

async function loadList() {
  const params = query();
  params.set("limit", String(PAGE));
  params.set("offset", String(offset));
  const page = await (await api("/v1/inbox?" + params)).json();
  const list = $("list");
  list.replaceChildren();
  if (page.items.length === 0) list.append(el("div", { class: "empty", text: "Nothing here." }));
  for (const item of page.items) {
    const row = el("button", { class: "item", type: "button", "data-ref": String(item.ref), "aria-current": String(item.ref === selected) },
      el("div", { class: "meta" },
        el("span", { class: "badge kind-" + item.kind, text: item.kind }),
        el("span", { class: "badge", text: item.status }),
        el("span", { text: "#" + item.ref + " · " + when(item.receivedAt) }),
        item.hasScreenshot ? el("span", { text: "· screenshot" }) : null,
        item.githubIssue ? el("span", { text: "· issue " + item.githubIssue }) : null),
      el("div", { class: "text", text: item.text }));
    row.addEventListener("click", () => open(item.ref));
    list.append(row);
  }
  $("page").textContent = page.total === 0 ? "" : (offset + 1) + "–" + (offset + page.items.length) + " of " + page.total;
  $("prev").disabled = offset === 0;
  $("next").disabled = offset + page.items.length >= page.total;
}

async function refresh() {
  await Promise.all([loadSummary(), loadList()]);
}

function dl(entries) {
  const list = el("dl");
  for (const [key, value] of entries) if (value !== "" && value !== null && value !== undefined) list.append(el("dt", { text: key }), el("dd", { text: String(value) }));
  return list;
}

async function open(ref) {
  selected = ref;
  for (const row of document.querySelectorAll(".item")) row.setAttribute("aria-current", String(row.dataset.ref === String(ref)));
  const item = await (await api("/v1/inbox/" + ref)).json();
  if (shotUrl) { URL.revokeObjectURL(shotUrl); shotUrl = null; }
  const detail = $("detail");
  detail.classList.remove("hidden");
  const status = el("select");
  for (const value of STATUSES) status.append(el("option", { value, text: value }));
  status.value = item.status;
  const note = el("textarea", { placeholder: "Team note", maxlength: "2000" });
  note.value = item.note || "";
  const save = el("button", { class: "primary", type: "button", text: "Save" });
  const saved = el("span", { class: "error" });
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      await api("/v1/inbox/" + ref, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: status.value, note: note.value }) });
      saved.textContent = "";
      await refresh();
    } catch (error) { if (error.message !== "auth") saved.textContent = "Not saved (" + error.message + ")"; }
    save.disabled = false;
  });
  const github = el("button", { type: "button", text: item.githubIssue ? "Issue " + item.githubIssue : "File to GitHub" });
  github.disabled = Boolean(item.githubIssue);
  github.addEventListener("click", async () => {
    github.disabled = true;
    try {
      const filed = await (await api("/v1/inbox/" + ref + "/github", { method: "POST" })).json();
      github.textContent = "Issue " + filed.issue;
      await loadList();
    } catch (error) { if (error.message !== "auth") { github.disabled = false; saved.textContent = "Not filed (" + error.message + ")"; } }
  });
  const shot = el("div");
  detail.replaceChildren(...[
    el("h2", {}, el("span", { class: "badge kind-" + item.kind, text: item.kind }), el("span", { text: "#" + item.ref })),
    el("div", { class: "body", text: item.text }),
    shot,
    dl([
      ["received", when(item.receivedAt)],
      ["written", item.createdAt],
      ["contact", item.contact],
      ["version", item.basics.version + " · " + item.basics.channel + " · " + item.basics.edition],
      ["locale", item.basics.locale],
      ["role", item.profile ? item.profile.role + " · AI " + item.profile.experience : ""],
      ["consent", Object.entries(item.consent).filter(([, on]) => on).map(([name]) => name).join(", ") || "none"],
      ["install", item.install],
    ]),
    item.technical ? el("details", {}, el("summary", { text: "Technical details" }), el("pre", { text: JSON.stringify(item.technical, null, 2) })) : null,
    el("div", { class: "actions" }, status, github),
    note,
    el("div", { class: "actions" }, save, saved),
  ].filter(Boolean));
  if (item.hasScreenshot) {
    try {
      shotUrl = URL.createObjectURL(await (await api("/v1/inbox/" + ref + "/screenshot")).blob());
      if (selected === ref) shot.append(el("img", { class: "shot", src: shotUrl, alt: "Screenshot" }));
    } catch {}
  }
}

function showKeys(on) {
  $("keys").classList.toggle("hidden", !on);
  for (const id of ["stats","filters","main"]) $(id).classList.toggle("hidden", on);
  $("keys-toggle").textContent = on ? "Feedback" : "Keys";
  if (on) loadKeys().catch(() => {});
}

async function loadKeys() {
  const { keys } = await (await api("/v1/inbox/keys")).json();
  const body = $("key-rows");
  body.replaceChildren();
  for (const key of keys) {
    const addresses = el("td");
    if (key.access.length === 0) addresses.append(el("span", { class: "revoked", text: "never used" }));
    for (const row of key.access) addresses.append(el("div", { class: "addr", text: row.address + " " },
      el("span", { text: "· first " + when(row.firstSeen) + " · last " + when(row.lastSeen) + " · " + row.hits + (row.hits === 1 ? " request" : " requests") })));
    const action = el("td");
    if (key.admin) action.append(el("span", { class: "revoked", text: "rotate on the server" }));
    else if (key.revokedAt) action.append(el("span", { class: "revoked", text: "revoked " + when(key.revokedAt) }));
    else {
      const revoke = el("button", { type: "button", text: "Revoke" });
      revoke.addEventListener("click", async () => {
        if (!confirm("Revoke key " + key.id + "? Anyone using it is signed out at once.")) return;
        revoke.disabled = true;
        try { await api("/v1/inbox/keys/" + key.id + "/revoke", { method: "POST" }); await loadKeys(); } catch { revoke.disabled = false; }
      });
      action.append(revoke);
    }
    body.append(el("tr", key.revokedAt ? { class: "revoked" } : {},
      el("td", {}, el("b", { text: key.id }), el("div", { class: "revoked", text: key.label })),
      el("td", { text: key.createdAt ? when(key.createdAt) : "—" }),
      addresses, action));
  }
}

async function start() {
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  try { me = await (await api("/v1/inbox/me")).json(); } catch (error) { if (error.message === "auth") return; }
  $("keys-toggle").classList.toggle("hidden", !(me && me.admin));
  $("who").textContent = me ? "Key: " + me.id : "";
  showKeys(false);
  try { await refresh(); } catch (error) { if (error.message !== "auth") $("stats").replaceChildren(el("div", { class: "error", text: "Inbox unavailable (" + error.message + ")" })); }
}

fill($("kind"), KINDS, "All kinds");
fill($("status"), STATUSES, "All statuses");
fill($("role"), ROLES, "All roles");
for (const name of ["kind","status","role","days"]) $(name).addEventListener("change", () => { offset = 0; refresh().catch(() => {}); });
$("prev").addEventListener("click", () => { offset = Math.max(0, offset - PAGE); loadList().catch(() => {}); });
$("next").addEventListener("click", () => { offset += PAGE; loadList().catch(() => {}); });
$("reload").addEventListener("click", () => refresh().catch(() => {}));
$("signout").addEventListener("click", () => signOut(""));
$("keys-toggle").addEventListener("click", () => showKeys($("keys").classList.contains("hidden")));
$("key-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("key-error").textContent = "";
  try {
    const response = await fetch("/v1/inbox/keys", { method: "POST", cache: "no-store", headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ id: $("key-id").value.trim(), label: $("key-label").value.trim() }) });
    if (!response.ok) { $("key-error").textContent = response.status === 409 ? "That name was already used." : "Not created (" + response.status + ")."; return; }
    const created = await response.json();
    $("key-id").value = ""; $("key-label").value = "";
    $("new-token").value = created.token;
    $("new-key-name").textContent = created.id;
    $("new-key").classList.remove("hidden");
    await loadKeys();
  } catch { $("key-error").textContent = "Not created."; }
});
$("copy-token").addEventListener("click", () => { navigator.clipboard.writeText($("new-token").value).then(() => { $("copy-token").textContent = "Copied"; }, () => $("new-token").select()); });
$("hide-token").addEventListener("click", () => { $("new-token").value = ""; $("new-key").classList.add("hidden"); $("copy-token").textContent = "Copy"; });
$("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  token = $("token").value.trim();
  $("token").value = "";
  if (!token) return;
  sessionStorage.setItem("inbox-token", token);
  start();
});
if (token) start();
`;

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Polyth feedback inbox</title>
<style>${STYLE}</style>
</head>
<body>
<section id="login">
  <form id="login-form" autocomplete="off">
    <h1>Feedback inbox</h1>
    <p>Enter the inbox token.</p>
    <input id="token" type="password" autocomplete="current-password" aria-label="Inbox token" required>
    <button class="primary" type="submit">Open</button>
    <div id="login-error" class="error" role="alert"></div>
  </form>
</section>
<section id="app" class="hidden">
  <header><h1>Feedback inbox</h1><span class="grow"></span><span id="who" class="revoked"></span><button id="keys-toggle" class="hidden" type="button">Keys</button><button id="reload" type="button">Refresh</button><button id="signout" type="button">Sign out</button></header>
  <div id="stats" class="stats"></div>
  <section id="keys" class="hidden">
    <div class="card">
      <h2>New key</h2>
      <p>One key per person or device, so each can be revoked alone. The key is shown once; the server keeps only its scrypt hash.</p>
      <form id="key-form" autocomplete="off">
        <input id="key-id" required pattern="[a-z0-9][a-z0-9\\-]{0,31}" maxlength="32" placeholder="name, e.g. anna-laptop" aria-label="Key name">
        <input id="key-label" maxlength="80" placeholder="Who or what it is for" aria-label="Label">
        <button class="primary" type="submit">Create key</button>
        <span id="key-error" class="error" role="alert"></span>
      </form>
      <div id="new-key" class="hidden" role="status">
        <p>Key <b id="new-key-name"></b> — copy it now, it will not be shown again.</p>
        <div class="secret"><input id="new-token" readonly aria-label="New key"><button id="copy-token" type="button">Copy</button><button id="hide-token" type="button">Done</button></div>
      </div>
    </div>
    <div class="card">
      <h2>Keys and where they were used</h2>
      <table><thead><tr><th>Key</th><th>Created</th><th>Addresses</th><th></th></tr></thead><tbody id="key-rows"></tbody></table>
    </div>
  </section>
  <div id="filters" class="filters">
    <select id="kind" aria-label="Kind"></select>
    <select id="status" aria-label="Status"></select>
    <select id="role" aria-label="Role"></select>
    <select id="days" aria-label="Period"><option value="">All time</option><option value="1">Last day</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select>
  </div>
  <main id="main">
    <div>
      <div id="list"></div>
      <div class="pager"><button id="prev" type="button">Previous</button><span id="page"></span><button id="next" type="button">Next</button></div>
    </div>
    <article id="detail" class="hidden" aria-live="polite"></article>
  </main>
</section>
<script>${SCRIPT}</script>
</body>
</html>
`;

const hash = (text: string): string => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

export const INBOX_PAGE = Buffer.from(HTML, "utf8");

/** Only this page's own script and style run; no frames, forms or other origins. */
export const INBOX_PAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": [
    "default-src 'none'",
    `script-src ${hash(SCRIPT)}`,
    `style-src ${hash(STYLE)}`,
    "img-src blob:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
});
