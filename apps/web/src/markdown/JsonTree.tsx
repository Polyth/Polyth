// Collapsible JSON tree (WP4). Fed by ```json code fences that parse cleanly;
// anything that does not parse stays a plain code block upstream.
import { useState } from "react";
import { tr } from "../i18n/index.ts";

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export function tryParseJson(text: string): JsonValue | undefined {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(t) as JsonValue;
  } catch {
    return undefined;
  }
}

function Leaf({ v }: { v: string | number | boolean | null }) {
  if (v === null) return <span className="jt-null">{tr("markdown.jsontree.null")}</span>;
  if (typeof v === "string") return <span className="jt-str">"{v}"</span>;
  if (typeof v === "boolean") return <span className="jt-bool">{String(v)}</span>;
  return <span className="jt-num">{String(v)}</span>;
}

function Node({ name, value, depth, defaultDepth }: { name?: string; value: JsonValue; depth: number; defaultDepth: number }) {
  const [open, setOpen] = useState(depth < defaultDepth);
  const label = name !== undefined ? <span className="jt-key">{name}: </span> : null;
  if (value === null || typeof value !== "object") {
    return <div className="jt-row" style={{ paddingLeft: depth * 14 }}>{label}<Leaf v={value} /></div>;
  }
  const isArr = Array.isArray(value);
  const entries = isArr ? (value as JsonValue[]).map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, JsonValue>);
  const brackets = isArr ? ["[", "]"] : ["{", "}"];
  return (
    <div>
      <div className="jt-row jt-toggle" style={{ paddingLeft: depth * 14 }} role="button" tabIndex={0}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((v) => !v); } }}
      >
        <span className="jt-chevron">{open ? "▾" : "▸"}</span>
        {label}
        <span className="jt-brace">{brackets[0]}</span>
        {!open && <span className="jt-count">{entries.length} {isArr ? tr("markdown.jsontree.items") : tr("markdown.jsontree.keys")}</span>}
        {!open && <span className="jt-brace">{brackets[1]}</span>}
      </div>
      {open && entries.map(([k, v]) => (
        <Node key={k} name={isArr ? undefined : k} value={v} depth={depth + 1} defaultDepth={defaultDepth} />
      ))}
      {open && <div className="jt-row" style={{ paddingLeft: depth * 14 }}><span className="jt-brace">{brackets[1]}</span></div>}
    </div>
  );
}

export default function JsonTree({ value, defaultDepth = 2 }: { value: JsonValue; defaultDepth?: number }) {
  return (
    <div className="json-tree" role="tree" aria-label={tr("markdown.jsontree.jsonTree")}>
      <Node value={value} depth={0} defaultDepth={Math.max(1, defaultDepth)} />
    </div>
  );
}
