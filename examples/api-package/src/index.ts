import { connectPolyth } from "@polyth/package-sdk";

const polyth = await connectPolyth();
const origin = "https://jsonplaceholder.typicode.com";
let status = "disconnected";
let result = "";

async function refreshStatus() {
  const connection = await polyth.auth.connection("demo");
  status = connection.status;
}

async function paint() {
  await polyth.ui.render({
    type: "stack",
    gap: "md",
    children: [
      { type: "heading", level: 2, text: "Example API" },
      { type: "badge", text: status, tone: status === "connected" ? "success" : "muted" },
      {
        type: "text",
        tone: "muted",
        text: "Tokens stay on the Polyth host. This package never receives credentials.",
      },
      {
        type: "inline",
        children: [
          { type: "button", label: "Connect", action: "connect", variant: "primary" },
          { type: "button", label: "Disconnect", action: "disconnect", disabled: status !== "connected" },
          { type: "button", label: "Fetch post", action: "fetch" },
        ],
      },
      result
        ? { type: "card", title: "Brokered response", body: result }
        : { type: "empty", title: "No request yet", body: "Connect optionally, then fetch a public post." },
    ],
  });
}

polyth.ui.onAction("connect", async () => {
  const connection = await polyth.auth.connect("demo");
  status = connection.status;
  await polyth.ui.toast({ kind: "success", message: "Connection stored on the host" });
  await paint();
});
polyth.ui.onAction("disconnect", async () => {
  const connection = await polyth.auth.disconnect("demo");
  status = connection.status;
  await paint();
});
polyth.ui.onAction("fetch", async () => {
  const response = await polyth.network.fetch({
    url: `${origin}/posts/1`,
    connectionId: status === "connected" ? "demo" : undefined,
  });
  result = `HTTP ${response.status}\n${response.body.slice(0, 400)}`;
  await paint();
});

await refreshStatus();
await paint();
