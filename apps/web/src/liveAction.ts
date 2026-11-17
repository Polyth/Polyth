// What an agent is doing right now, in the words the status line shows: the
// active task, a native subagent's task, the running tool with its target,
// thinking, or the activity fallback. The parent's live status line and the
// subagent branch under it read the same words from the same model.
import { executionPresentation, executionSummaryWords } from "./execution.ts";
import { tr } from "./i18n/index.ts";
import type { RenderModel } from "./reduce.ts";

/** The running tool in the timeline row's own words ("Test · Run tests"):
 *  the same presentation and naming helper, never a second naming path. */
function toolAction(model: RenderModel): string | undefined {
  const activeTool = [...model.messages].reverse().find((message) =>
    message.kind === "tool" && (message.status === "pending" || message.status === "running"));
  if (activeTool?.kind !== "tool") return undefined;
  const { title, preview } = executionSummaryWords(executionPresentation(activeTool));
  return [title, preview].filter((part) => part.trim() !== "").join(" · ");
}

/** The agent's own current action, when its log names one: a task, a native
 *  subagent's task, a running tool, or a thought with no answer yet. */
export function currentActionOf(model: RenderModel): string | undefined {
  const activeTask = model.tasks?.items.find((item) => item.status === "active");
  const activeSubagent = model.subagents?.agents.find((agent) => /^(?:working|running|active)$/i.test(agent.status));
  const latestAssistant = [...model.messages].reverse().find((message) => message.kind === "assistant");
  return activeTask?.text
    ?? activeSubagent?.currentTask
    ?? toolAction(model)
    ?? (latestAssistant?.kind === "assistant" && latestAssistant.reasoning && !latestAssistant.text
      ? tr("timeline.thinking")
      : undefined);
}

/** The current action of a working agent, never empty: the activity
 *  fallback ("Reading context…", "Preparing reply…" once an answer streams)
 *  stands in for a named one. */
export function liveActionOf(model: RenderModel): string {
  const latestAssistant = [...model.messages].reverse().find((message) => message.kind === "assistant");
  const activityLabels = tr("workspace.builtinsurfaces.activityItems").split("|");
  return currentActionOf(model)
    ?? activityLabels[latestAssistant?.kind === "assistant" && latestAssistant.text ? 2 : 0]
    ?? tr("workspace.builtinsurfaces.working");
}
