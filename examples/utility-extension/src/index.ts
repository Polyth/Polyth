import { connectPolyth, type RemoteUiNode } from "@polyth/package-sdk";

const polyth = await connectPolyth();
let draft = "";
let summary = "";

const settingsTree = (): RemoteUiNode => ({
  type: "stack",
  gap: "md",
  children: [
    { type: "heading", level: 2, text: "Utility notes" },
    { type: "text", tone: "muted", text: "This form is rendered by Polyth and stored in this package's Space-scoped storage." },
    {
      type: "textarea",
      label: "Note",
      placeholder: "Write a short note",
      value: draft,
      action: "utility.note",
    },
    {
      type: "inline",
      children: [
        { type: "button", label: "Save", action: "utility.save", variant: "primary" },
        {
          type: "button",
          label: "Summarize",
          action: "utility.summarize",
          disabled: !polyth.hasCapability("model.generate") || !draft.trim(),
        },
      ],
    },
    ...(summary
      ? [{ type: "card" as const, title: "Utility summary", body: summary }]
      : []),
  ],
});

polyth.ui.onAction("utility.note", (action) => {
  draft = typeof action.value === "string" ? action.value : draft;
});

polyth.ui.onAction("utility.save", async () => {
  await polyth.storage.set("note", draft);
  await polyth.ui.toast({ kind: "success", message: "Utility note saved" });
  await polyth.ui.render(settingsTree());
});

polyth.ui.onAction("utility.summarize", async () => {
  if (!polyth.hasCapability("model.generate") || !draft.trim()) return;
  const result = await polyth.model.generate({
    prompt: `Summarize this note in one concise sentence:\n\n${draft}`,
    maxOutputTokens: 128,
    timeoutMs: 20_000,
  });
  summary = result.text;
  await polyth.ui.render(settingsTree());
});

polyth.contributions.onInvoke(async (invocation) => {
  if (invocation.kind !== "settings-section" || invocation.contributionId !== "notes") return;
  draft = await polyth.storage.get("note") ?? "";
  summary = "";
  return { ui: settingsTree() };
});
