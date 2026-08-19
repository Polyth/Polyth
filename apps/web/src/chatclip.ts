function fenced(reference: string, content: string): string {
  return `${reference}\n\`\`\`\n${content}${content.endsWith("\n") ? "" : "\n"}\`\`\``;
}

export function formatSelectionChat(
  path: string,
  content: string,
  startLine: number,
  endLine: number,
): string {
  return fenced(`@${path} (lines ${startLine}-${endLine})`, content);
}

export function formatFileChat(path: string, content: string, maxChars: number): string {
  const reference = `@${path}`;
  return content.length <= maxChars ? fenced(reference, content) : reference;
}

/** 1-based line range covered by the [start, end) slice of content. */
export function lineRangeOf(
  content: string,
  start: number,
  end: number,
): { startLine: number; endLine: number } {
  const s = Math.max(0, Math.min(start, content.length));
  const e = Math.max(s, Math.min(end, content.length));
  let startLine = 1;
  for (let i = 0; i < s; i += 1) if (content.charCodeAt(i) === 10) startLine += 1;
  let endLine = startLine;
  for (let i = s; i < e; i += 1) if (content.charCodeAt(i) === 10) endLine += 1;
  // A selection ending exactly on a newline does not reach the next line.
  if (e > s && content.charCodeAt(e - 1) === 10) endLine -= 1;
  return { startLine, endLine: Math.max(startLine, endLine) };
}
