import { useState, type CSSProperties } from "react";
import type { McpBody, McpCallView, McpField, McpIcon } from "../toolCallView.ts";
import { todoSummary } from "../toolCallView.ts";
import { Icon } from "../icons.tsx";
import { openSession } from "../init.ts";
import type { TaskListState } from "../reduce.ts";
import { setUiError, useStore } from "../store.ts";
import { tr, type TranslationKey } from "../i18n/index.ts";

type TodoItem = TaskListState["items"][number];

const MCP_GLYPHS: Readonly<Record<McpIcon, (typeof Icon)[keyof typeof Icon]>> = {
  plan: Icon.plan,
  session: Icon.session,
  brain: Icon.brain,
  globe: Icon.globe,
  file: Icon.file,
  shield: Icon.shield,
  home: Icon.home,
  usage: Icon.usage,
  chat: Icon.chat,
  plug: Icon.plug,
  search: Icon.search,
  check: Icon.check,
  github: Icon.github,
  events: Icon.events,
};

export function McpGlyph({ icon }: { icon: McpIcon }) {
  const Glyph = MCP_GLYPHS[icon];
  return <Glyph />;
}

const STATUS_LABEL: Readonly<Record<TodoItem["status"], TranslationKey>> = {
  done: "toolcall.todoDone",
  active: "toolcall.statusInProgress",
  failed: "toolcall.todoCancelled",
  pending: "toolcall.statusNotStarted",
};

function TodoMark({ status }: { status: TodoItem["status"] }) {
  return (
    <span className={`execution-todo-mark ${status}`} aria-hidden="true">
      {status === "done" ? <Icon.check /> : status === "failed" ? "×" : status === "active" ? <i /> : null}
    </span>
  );
}

/** A todo list as it stood after one call: progress first, then each step.
 *  Steps the call changed carry a quiet marker so an update reads at a glance. */
export function TodoChecklist({ items, changed = [] }: { items: readonly TodoItem[]; changed?: readonly string[] }) {
  const { done, total } = todoSummary(items);
  const touched = new Set(changed);
  const percent = total ? Math.round((done / total) * 100) : 0;
  // The done count stays emphasized inside the translated sentence.
  const [beforeDone, afterDone] = tr("toolcall.todoProgress", { done: "\u0000", total }).split("\u0000");
  return (
    <section className="execution-todo" aria-label={tr("timeline.plan2")}>
      <div className="execution-todo-head">
        <span className="execution-todo-count">{beforeDone}<strong>{done}</strong>{afterDone}</span>
        <span
          className="execution-todo-meter"
          role="progressbar"
          aria-label={tr("toolcall.planProgress")}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
        >
          <span style={{ "--todo-progress": `${percent}%` } as CSSProperties} />
        </span>
      </div>
      <ol className="execution-todo-list">
        {items.map((item) => (
          <li key={item.id} className={`${item.status}${touched.has(item.id) ? " changed" : ""}`}>
            <TodoMark status={item.status} />
            <span className="execution-todo-text">{item.text}</span>
            <span className="sr-only">{tr(STATUS_LABEL[item.status])}</span>
            {touched.has(item.id) && <span className="execution-todo-changed">{tr("toolcall.updated")}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Fields({ fields }: { fields: readonly McpField[] }) {
  return (
    <dl className="execution-mcp-fields">
      {fields.map((field, index) => (
        <div key={`${index}:${field.label}`}>
          <dt>{field.label}</dt>
          <dd>{field.href
            ? <a href={field.href} target="_blank" rel="noreferrer">{field.value} <Icon.external /></a>
            : field.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SessionCard({ body }: { body: Extract<McpBody, { kind: "session" }> }) {
  const known = useStore((state) => body.sessionId
    ? state.sessions.some((session) => session.id === body.sessionId)
    : false);
  return (
    <div className="execution-mcp-session">
      <span className="execution-mcp-session-icon" aria-hidden="true"><Icon.session /></span>
      <span className="execution-mcp-session-copy">
        <strong>{body.title}</strong>
        {(body.status || body.detail) && <span>{[body.status, body.detail].filter(Boolean).join(" · ")}</span>}
      </span>
      {known && body.sessionId && (
        <button type="button" onClick={() => void openSession(body.sessionId!).catch((error) =>
          setUiError(error instanceof Error ? error.message : String(error)))}>
          {tr("toolcall.open")} <Icon.chevronRight />
        </button>
      )}
    </div>
  );
}

const TEXT_CLAMP = 600;

function ClampedText({ text, label, className }: { text: string; label?: string; className: string }) {
  const [all, setAll] = useState(false);
  const long = text.length > TEXT_CLAMP || text.split(/\r?\n/).length > 10;
  return (
    <div className={className}>
      {label && <span className="execution-mcp-message-label">{label}</span>}
      <p className={long && !all ? "clamped" : undefined}>{text}</p>
      {long && (
        <button type="button" className="execution-mcp-more" aria-expanded={all} onClick={() => setAll((value) => !value)}>
          {all ? tr("toolcall.showLess") : tr("timeline.showAll")}
        </button>
      )}
    </div>
  );
}

function ResultBody({ body }: { body: McpBody }) {
  if (body.kind === "todo") return <TodoChecklist items={body.items} changed={body.changed} />;
  if (body.kind === "session") return <SessionCard body={body} />;
  if (body.kind === "fields") return <Fields fields={body.fields} />;
  if (body.kind === "text") return <ClampedText text={body.text} className="execution-mcp-text" />;
  if (body.kind === "empty") return <p className="execution-mcp-empty">{body.text}</p>;
  return (
    <section className="execution-mcp-list" aria-label={body.label}>
      <div className="execution-mcp-list-head">
        <span>{body.label}</span>
        {body.total > body.items.length && <span>{tr("toolcall.shownOfTotal", { shown: body.items.length, total: body.total })}</span>}
      </div>
      <ul>
        {body.items.map((item, index) => (
          <li key={`${index}:${item.title}`}>
            <span className="execution-mcp-list-title">
              {item.href
                ? <a href={item.href} target="_blank" rel="noreferrer">{item.title}</a>
                : <span>{item.title}</span>}
              {item.meta && <small>{item.meta}</small>}
            </span>
            {item.detail && <span className="execution-mcp-list-detail">{item.detail}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Expanded body of an MCP call: what it carried, what came back, then the
 *  remaining request details in plain words. The raw call stays one click
 *  away in the row footer. */
export function McpCallDetail({ view, settled }: { view: McpCallView; settled: boolean }) {
  return (
    <div className="execution-mcp" data-mcp-icon={view.icon}>
      {view.message && <ClampedText text={view.message.text} label={view.message.label} className="execution-mcp-message" />}
      {view.result.map((body, index) => <ResultBody key={`${body.kind}:${index}`} body={body} />)}
      {settled && view.result.length === 0 && !view.message && view.request.length === 0 && (
        <p className="execution-mcp-empty">{tr("toolcall.todoDone")}</p>
      )}
      {view.request.length > 0 && (
        <section className="execution-mcp-request" aria-label={tr("toolcall.request")}>
          <div className="execution-mcp-list-head"><span>{tr("toolcall.request")}</span></div>
          <Fields fields={view.request} />
        </section>
      )}
    </div>
  );
}
