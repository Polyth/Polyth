import {
  connectPolyth,
  type ContributionInvocation,
  type ExternalResource,
  type StructuredContext,
} from "@polyth/package-sdk";

const polyth = await connectPolyth();

const tasks = [
  { id: "TASK-101", title: "Prepare release notes", status: "Open", summary: "Collect the user-visible changes for the next release." },
  { id: "TASK-102", title: "Verify mobile navigation", status: "In progress", summary: "Exercise the phone-sized navigation and context flows." },
  { id: "TASK-103", title: "Review deployment checks", status: "Done", summary: "Confirm the deployment validation checklist." },
];

type Task = (typeof tasks)[number];

const resource = (task: Task): ExternalResource => ({
  provider: "task-provider",
  resourceId: task.id,
  title: task.title,
  subtitle: `${task.id} · ${task.status}`,
  summary: task.summary,
  text: `Status: ${task.status}\n${task.summary}`,
  retrievedAt: Date.now(),
  metadata: { status: task.status },
  provenance: { source: "example-task-provider", retrievedAt: Date.now() },
});

const context = (task: Task): StructuredContext => ({
  provider: "task-provider",
  sourceId: task.id,
  title: task.title,
  retrievedAt: Date.now(),
  summary: task.summary,
  content: `Task ${task.id}\nStatus: ${task.status}\n${task.summary}`,
  metadata: { status: task.status },
});

async function pickTask(invocation: ContributionInvocation, query = ""): Promise<Task> {
  const filtered = tasks.filter((task) =>
    !query || `${task.id} ${task.title} ${task.summary}`.toLowerCase().includes(query.toLowerCase()));
  const shown = filtered.length ? filtered : tasks;
  await polyth.ui.render({
    type: "stack",
    gap: "md",
    children: [
      { type: "heading", level: 2, text: "Choose a task" },
      { type: "text", tone: "muted", text: "The picker is rendered entirely with Polyth UI primitives." },
      {
        type: "list",
        children: shown.map((task) => ({
          type: "listItem" as const,
          title: task.title,
          subtitle: `${task.id} · ${task.summary}`,
          action: `pick:${invocation.invocationId}:${task.id}`,
          trailing: { type: "badge" as const, text: task.status, tone: task.status === "Done" ? "success" as const : "info" as const },
        })),
      },
    ],
  });
  return new Promise<Task>((resolve) => {
    const off = shown.map((task) => polyth.ui.onAction(`pick:${invocation.invocationId}:${task.id}`, () => {
      for (const dispose of off) dispose();
      resolve(task);
    }));
  });
}

polyth.contributions.onInvoke(async (invocation) => {
  if (invocation.kind === "attachment-provider" && invocation.contributionId === "tasks") {
    const task = await pickTask(invocation, invocation.query);
    return { resources: [resource(task)], message: `${task.id} attached` };
  }

  if (invocation.kind === "context-provider" && invocation.contributionId === "task-context") {
    const task = await pickTask(invocation, invocation.query);
    return { context: [context(task)], message: `${task.id} context attached` };
  }

  if (invocation.kind === "message-action" && invocation.contributionId === "task-from-message") {
    const source = invocation.message.text?.trim() || "Follow up on the selected message";
    const task: Task = {
      id: "TASK-NEW",
      title: source.split("\n", 1)[0]!.slice(0, 80),
      status: "Open",
      summary: source.slice(0, 500),
    };
    return { resources: [resource(task)], message: "Task created from the selected message" };
  }

  if (invocation.kind === "session-action" && invocation.contributionId === "session-follow-up") {
    const task: Task = {
      id: "TASK-FOLLOW-UP",
      title: `Follow up: ${invocation.session.title}`.slice(0, 80),
      status: "Open",
      summary: `Follow-up task for session ${invocation.session.id}.`,
    };
    return { resources: [resource(task)], message: "Follow-up task attached" };
  }

  if (invocation.kind === "command" && invocation.contributionId === "task") {
    const task = await pickTask(invocation, invocation.arguments || invocation.query);
    return { resources: [resource(task)], message: `${task.id} attached` };
  }
});
