// Raw-wire probe: how does opencode 1.18.18 stream text for a given model?
// Spawns a private opencode serve, opens /event, sends one prompt, and counts
// message.part.delta / message.part.updated frames.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";

const dir = "/tmp/ocreal/phase-4/sse-probe";
mkdirSync(dir + "/project", { recursive: true });
const child = spawn("/home/ubuntu/.local/bin/opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
  cwd: dir + "/project",
  env: { ...process.env, XDG_DATA_HOME: dir + "/xdg", OPENCODE_CONFIG_DIR: dir + "/cfg" },
  stdio: ["ignore", "pipe", "pipe"],
});
let buf = "";
const port = await new Promise((resolve) => {
  const on = (c) => { buf += c; const m = buf.match(/listening on http:\/\/[^:]+:(\d+)/); if (m) resolve(Number(m[1])); };
  child.stdout.on("data", on); child.stderr.on("data", on);
});
console.log("port", port);
const base = `http://127.0.0.1:${port}`;
const dirParam = `directory=${encodeURIComponent(dir + "/project")}`;

const counts = {};
const sse = fetch(`${base}/event?${dirParam}`).then(async (res) => {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    acc += decoder.decode(value, { stream: true });
    let i;
    while ((i = acc.indexOf("\n\n")) >= 0) {
      const frame = acc.slice(0, i); acc = acc.slice(i + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("");
      if (!data) continue;
      try {
        const ev = JSON.parse(data);
        const key = ev.type + (ev.properties?.part?.type ? `:${ev.properties.part.type}` : "") + (ev.properties?.field ? `:${ev.properties.field}` : "");
        counts[key] = (counts[key] ?? 0) + 1;
        appendFileSync(dir + "/frames.ndjson", JSON.stringify({ t: Date.now(), type: key, bytes: data.length }) + "\n");
      } catch {}
    }
  }
});

const session = await fetch(`${base}/session?${dirParam}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "probe" }),
}).then((r) => r.json());
console.log("session", session.id);
const [providerID, modelID] = (process.env.S_MODEL ?? "opencode/big-pickle").split("/");
const prompt = await fetch(`${base}/session/${session.id}/prompt_async?${dirParam}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: { providerID, modelID }, parts: [{ type: "text", text: "Write a 600 word story about a lighthouse. Prose only." }] }),
});
console.log("prompt", prompt.status);
const deadline = Date.now() + 180000;
let lastIdle = false;
while (Date.now() < deadline && !lastIdle) {
  await new Promise((r) => setTimeout(r, 2000));
  const msgs = await fetch(`${base}/session/${session.id}/message?${dirParam}`).then((r) => r.json()).catch(() => []);
  const assistant = Array.isArray(msgs) ? msgs.filter((m) => m.info?.role === "assistant") : [];
  lastIdle = assistant.some((m) => m.info?.time?.completed);
  process.stdout.write(`\rcounts=${JSON.stringify(counts)} done=${lastIdle}   `);
}
console.log("\nfinal", JSON.stringify(counts, null, 1));
child.kill("SIGKILL");
process.exit(0);
