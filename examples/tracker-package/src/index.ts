import { connectPolyth } from "@polyth/package-sdk";

const polyth = await connectPolyth();

const items = [
  { id: "demo-1", title: "Review inbound queue", status: "open", subtitle: "Priority · demo-1" },
  { id: "demo-2", title: "Ship sandbox runtime notes", status: "done", subtitle: "Docs · demo-2" },
  { id: "demo-3", title: "Check broker timeouts", status: "open", subtitle: "Runtime · demo-3" },
];

let query = "";
let selected = items[0]!.id;

const visible = () => items.filter((item) =>
  item.title.toLowerCase().includes(query.toLowerCase()));

async function paint() {
  const project = polyth.hasCapability("project.readMetadata")
    ? await polyth.project.readMetadata()
    : null;
  const rows = visible();
  await polyth.ui.render({
    type: "stack",
    gap: "md",
    children: [
      { type: "heading", level: 2, text: "Tracker" },
      {
        type: "text",
        tone: "muted",
        text: project ? `Project ${project.name}` : "Generic work items. Polyth has no issue-tracker API.",
      },
      { type: "input", action: "search", value: query, placeholder: "Filter" },
      rows.length === 0
        ? { type: "empty", title: "No matching items", body: "Try a different filter." }
        : {
          type: "list",
          children: rows.map((item) => ({
            type: "listItem" as const,
            title: item.title,
            subtitle: item.subtitle,
            action: `select:${item.id}`,
            trailing: {
              type: "badge" as const,
              text: item.status,
              tone: item.status === "done" ? "success" as const : "info" as const,
            },
          })),
        },
      {
        type: "inline",
        children: [
          { type: "button", label: "Attach to session", action: "attach", variant: "primary" },
          { type: "button", label: "Insert title", action: "compose" },
        ],
      },
    ],
  });
}

polyth.ui.onAction("search", (action) => {
  query = typeof action.value === "string" ? action.value : "";
  void paint();
});
for (const item of items) {
  polyth.ui.onAction(`select:${item.id}`, () => {
    selected = item.id;
    void polyth.ui.toast({ kind: "info", message: item.title });
  });
}
polyth.ui.onAction("attach", async () => {
  const item = items.find((entry) => entry.id === selected) ?? items[0]!;
  await polyth.attachments.create({
    resourceId: item.id,
    title: item.title,
    subtitle: item.subtitle,
    kind: "context",
    text: `${item.title}\n${item.subtitle}`,
  });
  await polyth.ui.toast({ kind: "success", message: "Attached generic context" });
});
polyth.ui.onAction("compose", async () => {
  const item = items.find((entry) => entry.id === selected) ?? items[0]!;
  await polyth.composer.write(item.title, "replace");
});

await paint();
