import { modelChangeFrontier, type RenderModel, type RenderMessage } from "./reduce.ts";
import { appendEventSegments } from "./eventSegments.ts";
import { groupActivity, mergeThinking, type ActivityGroup } from "./utils.ts";

type Row = RenderMessage | ActivityGroup;
const separator = (message: RenderMessage): boolean => message.kind === "user" || message.kind === "notice" || message.kind === "github-conflict";

/** Rebuild only the changed conversation segment. The reducer's explicit
 * frontier is the authority; mutable message identity is never a cache key. */
export function createTimelineDerivation() {
  let priorEpoch: object | undefined;
  let priorMode: unknown;
  let priorGrouping: unknown;
  let prefixEnd = -1;
  let prefixMessages: RenderMessage[] = [];
  let prefixRows: Row[] = [];
  return (model: RenderModel, mode: Parameters<typeof groupActivity>[1], grouping: Parameters<typeof groupActivity>[2], visible: (message: RenderMessage) => boolean) => {
    const frontier = modelChangeFrontier(model);
    let boundary = frontier.fromIndex;
    while (boundary > 0 && !(separator(model.messages[boundary]!) && visible(model.messages[boundary]!))) boundary--;
    if (frontier.epoch !== priorEpoch || mode !== priorMode || grouping !== priorGrouping || prefixEnd !== boundary) {
      prefixMessages = appendEventSegments([], model.messages.slice(0, boundary).filter(visible));
      prefixRows = appendEventSegments([], groupActivity(mergeThinking(prefixMessages), mode, grouping));
      prefixEnd = boundary;
      priorEpoch = frontier.epoch;
      priorMode = mode;
      priorGrouping = grouping;
    }
    const tail = model.messages.slice(boundary).filter(visible);
    return {
      messages: appendEventSegments(prefixMessages, tail),
      rows: appendEventSegments(prefixRows, groupActivity(mergeThinking(tail), mode, grouping)),
      epoch: frontier.epoch,
    };
  };
}
