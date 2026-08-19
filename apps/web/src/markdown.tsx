// Markdown-lite: fenced code, headers, bold, italic, inline code, lists, horizontal rules. No dependency.
import type { ReactNode } from "react";

// Process inline formatting within a single line: **bold**, *italic*, `code`, ~~strike~~
function inline(text: string, keyBase: string): ReactNode[] {
  // Split on all inline patterns: code, bold+italic, bold, italic, strike
  const parts = text.split(/(`[^`]+`|\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~)/g);
  const out: ReactNode[] = [];
  parts.forEach((p, i) => {
    if (i % 2 === 0) {
      if (p) out.push(<span key={`${keyBase}-t${i}`}>{p}</span>);
    } else if (p.startsWith("`")) {
      out.push(<code key={`${keyBase}-c${i}`}>{p.slice(1, -1)}</code>);
    } else if (p.startsWith("~~")) {
      out.push(<del key={`${keyBase}-d${i}`}>{p.slice(2, -2)}</del>);
    } else if (p.startsWith("***")) {
      out.push(<strong key={`${keyBase}-b${i}`}><em>{p.slice(3, -3)}</em></strong>);
    } else if (p.startsWith("**")) {
      out.push(<strong key={`${keyBase}-b${i}`}>{p.slice(2, -2)}</strong>);
    } else if (p.startsWith("*")) {
      out.push(<em key={`${keyBase}-e${i}`}>{p.slice(1, -1)}</em>);
    }
  });
  return out;
}

// Render inline-formatted text inside a line element
function inlineLine(text: string, keyBase: string): ReactNode[] {
  return inline(text, keyBase);
}

// Group consecutive list items into <ul>
function renderLines(text: string, keyBase: string): ReactNode[] {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let listBuf: string[] = [];
  let listKey = 0;

  const flushList = () => {
    if (listBuf.length === 0) return;
    out.push(
      <ul key={`${keyBase}-ul${listKey++}`}>
        {listBuf.map((item, i) => (
          <li key={i}>{inlineLine(item, `${keyBase}-li${i}`)}</li>
        ))}
      </ul>,
    );
    listBuf = [];
  };

  for (const line of lines) {
    const hrMatch = /^\s*([-*_])\s*\1\s*\1(?:\s|\1)*$/.exec(line);
    const headerMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    const listMatch = /^\s*[-*+]\s+(.+)$/.exec(line);
    const numListMatch = /^\s*\d+\.\s+(.+)$/.exec(line);

    if (hrMatch) {
      flushList();
      out.push(<hr key={`${keyBase}-hr${listKey++}`} />);
    } else if (headerMatch) {
      flushList();
      const level = headerMatch[1]!.length;
      const tag = (`h${level}`) as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      const H = tag;
      out.push(<H key={`${keyBase}-h${listKey++}`}>{inlineLine(headerMatch[2]!, `${keyBase}-ht${listKey}`)}</H>);
    } else if (listMatch) {
      listBuf.push(listMatch[1]!);
    } else if (numListMatch) {
      listBuf.push(numListMatch[1]!);
    } else if (line.trim() === "") {
      flushList();
      out.push(<div key={`${keyBase}-br${listKey++}`} style={{ height: 6 }} />);
    } else {
      flushList();
      out.push(<div key={`${keyBase}-ln${listKey++}`}>{inlineLine(line, `${keyBase}-l${listKey}`)}</div>);
    }
  }
  flushList();
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
      out.push(...renderLines(b, `${keyBase}-${i}`));
    }
  });
  return out;
}
