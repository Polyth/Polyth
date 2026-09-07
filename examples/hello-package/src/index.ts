import { connectPolyth } from "@polyth/package-sdk";

const polyth = await connectPolyth();

const paint = () => polyth.ui.render({
  type: "stack",
  gap: "md",
  children: [
    { type: "heading", level: 2, text: "Hello package" },
    {
      type: "text",
      tone: "muted",
      text: `Theme ${polyth.ready.theme.mode} · ${polyth.ready.locale}`,
    },
    {
      type: "text",
      text: "This view is submitted by a sandboxed package and rendered with Polyth primitives.",
    },
    { type: "button", label: "Say hello", action: "hello", variant: "primary" },
  ],
});

polyth.ui.onAction("hello", () => {
  void polyth.ui.toast({ kind: "success", message: "Hello from a sandboxed package" });
});

await paint();
