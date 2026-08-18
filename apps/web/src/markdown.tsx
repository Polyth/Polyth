// Markdown-lite: fenced code blocks + inline code only. No dependency.
import type { ReactNode } from "react";

function inline(text: string, keyBase: string): ReactNode[] {
  const parts = text.split(/`([^`]+)`/g);
  const out: ReactNode[] = [];
  parts.forEach((p, i) => {
    if (i % 2 === 1) out.push(<code key={`${keyBase}-c${i}`}>{p}</code>);
    else if (p !== "") out.push(<span key={`${keyBase}-t${i}`}>{p}</span>);
  });
  return out;
}

export function renderMarkdown(text: string, keyBase = "md"): ReactNode[] {
  const blocks = text.split(/```([\s\S]*?)```/g);
  const out: ReactNode[] = [];
  blocks.forEach((b, i) => {
    if (i % 2 === 1) {
      out.push(
        <pre key={`${keyBase}-p${i}`}>
          <code>{b.trim()}</code>
        </pre>,
      );
    } else {
      out.push(...inline(b, `${keyBase}-${i}`));
    }
  });
  return out;
}