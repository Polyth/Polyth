import { useEffect, useRef } from "react";
import { renderMarkdown } from "../markdown.tsx";
import { fmtCost, fmtMs, fmtTokens } from "../format.ts";
import type { RenderModel, RenderMessage, ToolMsg, AssistantMsg } from "../reduce.ts";

function AssistantView({ m }: { m: AssistantMsg }) {
  return (
    <div className="msg assistant">
      {m.reasoning !== "" && (
        <details className="reasoning" open={!m.finalized}>
          <summary>Reasoning{m.finalized ? "" : "…"}</summary>
          <div className="reasoning-body">{m.reasoning}</div>
        </details>
      )}
      <div className="bubble">{renderMarkdown(m.text || "", m.id)}{!m.finalized && <span className="caret" />}</div>
    </div>
  );
}

function ToolCard({ m }: { m: ToolMsg }) {
  const done = m.status !== "pending";
  const inputJson = JSON.stringify(m.input, null, 2);
  return (
    <details className={`tool-card ${m.status === "error" ? "error" : ""}`} open={!done}>
      <summary className="tool-head">
        <span className="tool-icon">
          {m.status === "pending" ? (
            <span className="spinner" />
          ) : m.status === "done" ? (
            <span className="ok">✓</span>
          ) : (
            <span className="err">✕</span>
          )}
        </span>
        <span className="tool-name">{m.tool}</span>
        <span className="tool-dur">{m.finishTime !== undefined ? fmtMs(m.finishTime - m.time) : ""}</span>
      </summary>
      <div className="tool-body">
        <div className="tool-section">
          <div className="tool-label">Input</div>
          <pre className="json">{inputJson}</pre>
        </div>
        {m.error !== undefined && (
          <div className="tool-section error">
            <div className="tool-label">Error</div>
            <pre className="json">{m.error}</pre>
          </div>
        )}
        {m.output !== undefined && (
          <div className="tool-section">
            <div className="tool-label">Output</div>
            <pre className="out">{m.output}</pre>
          </div>
        )}
      </div>
    </details>
  );
}

function MessageView({ m }: { m: RenderMessage }) {
  if (m.kind === "user") {
    return (
      <div className="msg user">
        <div className="bubble">
          {renderMarkdown(m.text, m.id)}
          {m.raw && m.raw !== m.text && (
            <div className="user-expanded-hint">
              expanded from <code>{m.raw.split("\n")[0] ?? m.raw}</code>
            </div>
          )}
        </div>
      </div>
    );
  }
  if (m.kind === "assistant") return <AssistantView m={m} />;
  return <ToolCard m={m} />;
}

// Footer under the last assistant message once the turn finished with usage.
function turnFooter(model: RenderModel): string | null {
  const t = model.turn;
  const last = model.messages[model.messages.length - 1];
  const hasUsage = model.totals.input + model.totals.output + model.totals.cost > 0;
  if (!t || t.status !== "stopped" || last?.kind !== "assistant" || !last.finalized || !hasUsage) return null;
  const bits: string[] = [];
  if (t.model) bits.push(`${t.model.providerID}/${t.model.modelID}`);
  if (t.agent) bits.push(t.agent);
  if (model.totals.input + model.totals.output > 0) {
    bits.push(`${fmtTokens(model.totals.input)} in · ${fmtTokens(model.totals.output)} out`);
  }
  if (model.totals.cost > 0) bits.push(fmtCost(model.totals.cost));
  return bits.join(" · ");
}

export default function Timeline({ model }: { model: RenderModel }) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [model.version]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const footer = turnFooter(model);

  return (
    <div className="timeline" ref={ref} onScroll={onScroll}>
      {model.messages.length === 0 && <div className="empty">No messages yet — say hi below.</div>}
      {model.messages.map((m) => (
        <MessageView key={m.id} m={m} />
      ))}
      {footer && <div className="turn-footer">{footer}</div>}
    </div>
  );
}