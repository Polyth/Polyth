// Host-native rendering of an agent's ```ui fence. The agent writes data (or
// points at a project data file); layout, sorting, filtering, paging and
// selection happen here at zero token cost. Only an explicit click on a
// button sends a short user message back.
import { useMemo, useState, type ReactNode } from "react";
import type { MarkdownFenceContext, MarkdownFenceRendererProps, WebPackageHost } from "@polyth/web-sdk";
import { Button, CheckIcon, CodeIcon, GridViewIcon, IconButton, ListViewIcon, Notice } from "../../../apps/web/src/components/ui/index.ts";
import {
  CHAT_BLOCK_VIEWS,
  actionMessage,
  answeredBy,
  blockActions,
  chatBlockMarkdown,
  formMessage,
  parseChatBlock,
  problemsMessage,
  selectionLabels,
  withRecords,
  type ChatBlockAction,
  type ChatBlockDoc,
  type ChatBlockProblem,
} from "../src/parse.ts";
import { CardsView, ChoiceView, ListView, StatsView, TableView, sortItems } from "./collections.tsx";
import ChartView from "./ChartView.tsx";
import CompareView from "./CompareView.tsx";
import FormView, { invalidFields, missingFields } from "./FormView.tsx";
import MediaView from "./MediaView.tsx";
import StepsView from "./StepsView.tsx";
import { BlockHead, ProblemsPanel, ToolsContext } from "./shared.tsx";
import { chatBlockStrings, fill, type ChatBlockStrings } from "./strings.ts";
import { useBlockRecords, type RecordsError } from "./useBlockRecords.ts";

// Presentation-only memory, keyed by the host's per-block key, so a block
// that remounts (scroll virtualization, re-render) keeps its selection, form
// input and "sent" state. Never persisted; the sent message itself is canonical.
const selections = new Map<string, ReadonlySet<number>>();
const formInputs = new Map<string, Readonly<Record<string, string>>>();
const sentMessages = new Map<string, string>();
const MEMORY_LIMIT = 300;
const remember = <T,>(map: Map<string, T>, key: string, value: T) => {
  map.delete(key);
  map.set(key, value);
  if (map.size > MEMORY_LIMIT) map.delete(map.keys().next().value!);
};

export interface ChatBlockProps extends MarkdownFenceRendererProps {
  host: Pick<WebPackageHost, "conversation" | "ui">;
}

export default function ChatBlock(props: ChatBlockProps): ReactNode {
  const { text, closed, source, context, host } = props;
  const locale = host.ui.locale.get();
  const t = chatBlockStrings(locale);
  const parsed = useMemo(() => parseChatBlock(text, closed), [text, closed]);
  const [asText, setAsText] = useState(false);
  const file = parsed.ok ? parsed.doc.source : undefined;
  // A file is read once the fence is complete; while it streams the path may
  // still be growing.
  const records = useBlockRecords(file, context, closed);

  if (!parsed.ok) {
    if (!closed) return <PendingBlock label={t.loading} />;
    if (parsed.reason !== "unknown-view") return source;
    // An unknown view keeps the host's code frame, with what went wrong.
    const problems: ChatBlockProblem[] = [{
      code: "unknown-view",
      line: 1,
      text: parsed.view ?? "",
      hint: fill(t.unknownViewHint, { views: CHAT_BLOCK_VIEWS.join(", ") }),
    }];
    return (
      <>
        {source}
        <ProblemsPanel problems={problems} t={t} host={host} context={context} message={problemsMessage("", parsed.view ?? "ui", problems)} />
      </>
    );
  }
  let doc = parsed.doc;
  let notice: ReactNode = null;
  if (file) {
    const state = records.state;
    if (state.status === "ready") {
      doc = withRecords(doc, state.records, { total: state.total, truncated: state.truncated });
    } else if (state.status === "error") {
      notice = <Notice tone="warning">{fill(errorCopy(t, state.error), { path: file })}</Notice>;
    } else {
      notice = <div className="chat-block-pending chat-block-loading" role="status" aria-label={fill(t.loadingFile, { path: file })} />;
    }
  }
  return (
    <ChatBlockFrame doc={doc} t={t} asText={asText} setAsText={setAsText} source={source} {...(file ? { reload: records.reload } : {})}>
      {!asText && (notice
        ? <><BlockHead title={doc.title} />{notice}</>
        : <ChatBlockBody doc={doc} t={t} host={host} context={context} streaming={!closed} locale={locale} />)}
    </ChatBlockFrame>
  );
}

function errorCopy(t: ChatBlockStrings, error: RecordsError): string {
  switch (error) {
    case "no-project": return t.fileNoProject;
    case "not-found": return t.fileNotFound;
    case "too-large": return t.fileTooLarge;
    case "format": return t.fileFormat;
    case "empty": return t.fileEmpty;
    default: return t.fileUnavailable;
  }
}

function PendingBlock({ label }: { label: string }) {
  return (
    <section className="chat-block" aria-busy="true" aria-label={label}>
      <div className="chat-block-pending" style={{ blockSize: "120px" }} />
    </section>
  );
}

function ChatBlockFrame({ doc, t, asText, setAsText, source, reload, children }: {
  doc: ChatBlockDoc;
  t: ChatBlockStrings;
  asText: boolean;
  setAsText(value: boolean): void;
  source: ReactNode;
  reload?: () => void;
  children: ReactNode;
}) {
  const markdown = useMemo(() => chatBlockMarkdown(doc), [doc]);
  return (
    <section className={`chat-block chat-block--${doc.view}`} aria-label={doc.title || undefined}>
      {asText ? (
        <>
          <header className="chat-block-head">
            {doc.title && <span className="chat-block-title">{doc.title}</span>}
            <div className="chat-block-tools">
              <IconButton icon={CodeIcon} label={t.showView} size="sm" pressed onClick={() => setAsText(false)} />
            </div>
          </header>
          {source}
        </>
      ) : (
        <ToolsContext.Provider value={{ markdown, t, toggleText: () => setAsText(true), ...(reload ? { reload } : {}) }}>
          {children}
        </ToolsContext.Provider>
      )}
    </section>
  );
}

function ChatBlockBody({ doc, t, host, context, streaming, locale }: {
  doc: ChatBlockDoc;
  t: ChatBlockStrings;
  host: ChatBlockProps["host"];
  context: MarkdownFenceContext;
  streaming: boolean;
  locale: string;
}) {
  const key = context.blockKey;
  const [picked, setPicked] = useState<ReadonlySet<number> | null>(() => selections.get(key) ?? null);
  const [inputs, setValues] = useState<Readonly<Record<string, string>>>(() => formInputs.get(key) ?? {});
  const [sentHere, setSent] = useState<string | null>(() => sentMessages.get(key) ?? null);
  const [sending, setSending] = useState(false);
  const [layout, setLayout] = useState<"cards" | "list">(doc.view === "list" ? "list" : "cards");
  // The user message that followed this answer may be this block's own: a
  // reloaded conversation then shows the block as answered, with the
  // selection or form values that message names.
  const answered = useMemo(
    () => (sentHere === null ? answeredBy(doc, context.reply, { send: t.send, yes: t.yes, no: t.no }) : null),
    [doc, context.reply, sentHere, t],
  );
  const sent = sentHere ?? answered?.message ?? null;
  const locked = sent !== null;
  const values = answered?.values ? { ...answered.values, ...inputs } : inputs;

  const selected = picked
    ?? (answered?.selected ? new Set(answered.selected) : new Set(doc.items.filter((item) => item.selected).map((item) => item.index)));
  const toggle = (index: number) => {
    if (locked) return;
    const next = new Set(doc.pick === "one" ? [] : selected);
    if (selected.has(index)) next.delete(index);
    else next.add(index);
    remember(selections, key, next);
    setPicked(next);
  };
  const setValue = (name: string, value: string) => {
    if (locked) return;
    const next = { ...values, [name]: value };
    remember(formInputs, key, next);
    setValues(next);
  };
  // A compare selection names columns; every other view names items (with
  // their ids, so the agent need not match titles).
  const selectedTitles = selectionLabels(doc).filter((entry) => selected.has(entry.index)).map((entry) => entry.label);

  const deliver = async (message: string) => {
    const sessionId = context.sessionId;
    const draftOnly = doc.options.send === "draft";
    if (!sessionId || draftOnly) {
      host.conversation.insert(message);
      return;
    }
    // One click, one message: the buttons stay disabled until the send settles.
    setSending(true);
    let ok = false;
    try {
      ok = await host.conversation.send(sessionId, message);
    } catch {
      ok = false;
    } finally {
      setSending(false);
    }
    if (!ok) {
      // A refused send keeps the user's intent as an editable draft.
      host.conversation.insert(message);
      return;
    }
    remember(sentMessages, key, message);
    setSent(message);
  };

  const pickedSuffix = doc.pick === "many" && selected.size > 0 ? fill(t.selectedCount, { count: selected.size }) : "";
  const loadedNote = doc.loaded?.truncated ? fill(t.fileTruncated, { shown: doc.items.length, total: doc.loaded.total }) : "";

  const missing = doc.view === "form" ? missingFields(doc, values) : [];
  const invalid = doc.view === "form" ? invalidFields(doc, values) : [];

  let body: ReactNode;
  switch (doc.view) {
    case "cards":
    case "list": {
      const items = sortItems(doc.items, doc.options.sort);
      const collection = { doc, items, selected, toggle, t, context, streaming, locked };
      body = (
        <>
          <BlockHead title={doc.title} count={String(doc.items.length)}>
            {items.some((item) => item.image) && (
              <>
                <IconButton icon={GridViewIcon} label={t.cardsView} size="sm" pressed={layout === "cards"} onClick={() => setLayout("cards")} />
                <IconButton icon={ListViewIcon} label={t.listView} size="sm" pressed={layout === "list"} onClick={() => setLayout("list")} />
              </>
            )}
          </BlockHead>
          {layout === "cards" ? <CardsView {...collection} /> : <ListView {...collection} />}
        </>
      );
      break;
    }
    case "table":
      body = <TableView doc={doc} t={t} />;
      break;
    case "stats":
      body = <><BlockHead title={doc.title} /><StatsView doc={doc} streaming={streaming} /></>;
      break;
    case "choice":
      body = <><BlockHead title={doc.title} /><ChoiceView doc={doc} selected={selected} toggle={toggle} locked={locked} /></>;
      break;
    case "chart":
      body = <ChartView doc={doc} t={t} locale={locale} />;
      break;
    case "compare":
      body = <CompareView doc={doc} t={t} context={context} selected={selected} toggle={toggle} locked={locked} />;
      break;
    case "form":
      body = <FormView doc={doc} t={t} values={values} setValue={setValue} locked={locked} invalid={invalid} />;
      break;
    case "steps":
      body = <StepsView doc={doc} t={t} streaming={streaming} />;
      break;
    case "media":
      body = <MediaView doc={doc} t={t} context={context} selected={selected} toggle={toggle} locked={locked} streaming={streaming} />;
      break;
  }

  // A choice and a form always offer Send; other views only show the agent's buttons.
  const actions = blockActions(doc, t.send);
  const messageFor = (action: ChatBlockAction): string => {
    if (doc.view === "form") {
      return formMessage(doc, values, { yes: t.yes, no: t.no }, action.message);
    }
    if (doc.view === "choice" && !action.message) {
      const answer = selectedTitles.join(", ");
      return doc.title ? `${doc.title} — ${answer}` : answer;
    }
    return actionMessage(action, selectedTitles);
  };
  const blocked = (action: ChatBlockAction) =>
    missing.length > 0
    || invalid.length > 0
    || ((doc.view === "choice" || action.message?.includes("{sel}") === true) && selected.size === 0);
  const note = locked
    ? null
    : missing.length > 0
      ? fill(t.missing, { fields: missing.join(", ") })
      : invalid.length > 0 ? fill(t.invalid, { fields: invalid.join(", ") }) : pickedSuffix;

  return (
    <>
      {body}
      {loadedNote && <p className="chat-block-sub chat-block-notes">{loadedNote}</p>}
      {doc.notes.length > 0 && <p className="chat-block-sub chat-block-notes">{doc.notes.join("\n")}</p>}
      {doc.problems.length > 0 && !streaming && (
        <ProblemsPanel
          problems={doc.problems}
          t={t}
          host={host}
          context={context}
          message={problemsMessage(doc.title, doc.view, doc.problems)}
        />
      )}
      {(actions.length > 0 || pickedSuffix) && !streaming && (
        <footer className="chat-block-actions">
          <span className={`chat-block-actions-note${locked ? " is-done" : ""}`} role="status">
            {locked
              ? <><CheckIcon strokeWidth={2.5} aria-hidden="true" /><span className="chat-block-sent-label">{t.sentTo}</span><span className="chat-block-sent-text" title={sent}>· {sent}</span></>
              : note}
          </span>
          {!locked && actions.length > 0 && (
            <div className="chat-block-actions-buttons">
              {actions.map((action, index) => (
                <Button
                  key={`${index}-${action.label}`}
                  size="sm"
                  variant={index === actions.length - 1 ? "primary" : "quiet"}
                  disabled={sending || blocked(action)}
                  busy={sending}
                  title={messageFor(action)}
                  onClick={() => { void deliver(messageFor(action)); }}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          )}
        </footer>
      )}
    </>
  );
}
