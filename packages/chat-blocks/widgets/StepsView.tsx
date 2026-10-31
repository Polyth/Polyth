// A plan or progress timeline. It is read-only: markers are filled discs
// (a number, or a glyph for a settled step), never an empty ring that reads
// as a checkbox. Status is shown by glyph and by text, never by colour alone;
// the self-evident states (to do, done, skipped) keep their words for
// assistive tech only.
import type { ChatBlockDoc, StepStatus } from "../src/parse.ts";
import { CheckIcon, CloseIcon, MinusIcon } from "../../../apps/web/src/components/ui/index.ts";
import { BlockHead, InlineText } from "./shared.tsx";
import { fill, type ChatBlockStrings } from "./strings.ts";

const MARKS: Readonly<Partial<Record<StepStatus, typeof CheckIcon>>> = { done: CheckIcon, fail: CloseIcon, skip: MinusIcon };
const SPOKEN_ONLY: ReadonlySet<StepStatus> = new Set(["todo", "done", "skip"]);

export default function StepsView({ doc, t, streaming }: { doc: ChatBlockDoc; t: ChatBlockStrings; streaming: boolean }) {
  const done = doc.items.filter((item) => item.status === "done").length;
  // A plan nobody has started is not a checklist to tick off: it counts its
  // steps instead of showing "0/4".
  const started = doc.items.some((item) => item.status !== "todo");
  const count = doc.items.length === 0 ? undefined : started ? fill(t.progress, { done, total: doc.items.length }) : String(doc.items.length);
  const statusLabel: Readonly<Record<StepStatus, string>> = {
    done: t.stepDone, doing: t.stepDoing, todo: t.stepTodo, fail: t.stepFail, skip: t.stepSkip,
  };
  return (
    <>
      <BlockHead title={doc.title} count={count} />
      <ol className="chat-block-steps">
        {doc.items.map((item, position) => {
          const status = item.status ?? "todo";
          const Glyph = MARKS[status];
          return (
            <li key={item.index} className={`chat-block-step is-${status}${streaming ? " chat-block-enter" : ""}`} aria-current={status === "doing" ? "step" : undefined}>
              <span className="chat-block-step-mark" aria-hidden="true">{Glyph ? <Glyph strokeWidth={2.75} /> : position + 1}</span>
              <div className="chat-block-step-text">
                <div className="chat-block-step-line">
                  <span className="chat-block-step-title"><InlineText text={item.title} /></span>
                  <span className={`chat-block-step-state${SPOKEN_ONLY.has(status) ? " sr-only" : ""}`}>{statusLabel[status]}</span>
                </div>
                {item.subtitle && <span className="chat-block-step-detail"><InlineText text={item.subtitle} /></span>}
              </div>
            </li>
          );
        })}
        {doc.pending && <li className="chat-block-step chat-block-pending" aria-hidden="true" />}
      </ol>
    </>
  );
}
