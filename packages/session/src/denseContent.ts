// Dense-content stripping for the compaction summarizer's input only. A
// conversation can carry megabytes of base64, data URIs, fences and logs that
// a summary cannot use and should not be charged for. Canonical history is
// never changed: callers pass message text and receive a smaller copy.

const MIN_BASE64_RUN = 200;
const FENCED_BLOCK_MAX_CHARS = 4 * 1024;
const HEAD_LINES = 20;
const TAIL_LINES = 5;
const LOG_RUN_MAX_LINES = 200;
// Our own marker from an earlier pass; a block already cut is left alone so
// the function stays idempotent even when its head is still large.
const OMISSION_MARKER = /\[… \d+ lines omitted\]/;

const BASE64_CHAR = new Uint8Array(128);
for (const character of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=_-") {
  BASE64_CHAR[character.charCodeAt(0)] = 1;
}

const isBase64 = (code: number): boolean => code < 128 && BASE64_CHAR[code] === 1;

/** Characters that end a data URI token in ordinary message text. */
const DATA_URI_STOP = "\"'<>`()[]{}";

const omitted = (lines: number): string => `[… ${lines} lines omitted]`;

const kilobytes = (chars: number): number => Math.max(1, Math.ceil(chars / 1024));

/** Replace data URIs and long base64 runs in one left-to-right scan. */
function stripInlineDense(text: string): string {
  const parts: string[] = [];
  let copied = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (
      code === 100 &&
      text.charCodeAt(index + 1) === 97 &&
      text.charCodeAt(index + 2) === 116 &&
      text.charCodeAt(index + 3) === 97 &&
      text.charCodeAt(index + 4) === 58 &&
      (index === 0 || !/[A-Za-z0-9_/.-]/.test(text[index - 1]!))
    ) {
      let end = index + 5;
      while (end < text.length) {
        const character = text[end]!;
        if (character <= " " || DATA_URI_STOP.includes(character)) break;
        end++;
      }
      const token = text.slice(index, end);
      if (token.includes(",")) {
        parts.push(text.slice(copied, index), `[base64 data, ${kilobytes(token.length)} KB omitted]`);
        copied = end;
        index = end;
        continue;
      }
    }
    if (isBase64(code)) {
      let end = index + 1;
      while (end < text.length && isBase64(text.charCodeAt(end))) end++;
      if (end - index >= MIN_BASE64_RUN) {
        parts.push(text.slice(copied, index), `[base64 data, ${kilobytes(end - index)} KB omitted]`);
        copied = end;
      }
      index = end;
      continue;
    }
    index++;
  }
  return copied === 0 ? text : parts.join("") + text.slice(copied);
}

interface SourceLine {
  text: string;
  fenced: boolean;
}

const fenceOpener = (line: string): { marker: string; length: number } | undefined => {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) return undefined;
  return { marker: match[1]![0]!, length: match[1]!.length };
};

const closesFence = (line: string, marker: string, length: number): boolean => {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return !!match && match[1]![0] === marker && match[1]!.length >= length;
};

const cutLines = (lines: readonly string[], head: number, tail: number): string[] => [
  ...lines.slice(0, head),
  omitted(lines.length - head - tail),
  ...lines.slice(lines.length - tail),
];

/** Find fenced blocks, and cut each larger than 4 KB to its first 20 and last
 *  5 lines. The fence and its language tag stay; an unclosed fence is left
 *  as it was written. */
function cutFencedBlocks(lines: readonly string[]): SourceLine[] {
  const output: SourceLine[] = [];
  for (let index = 0; index < lines.length; index++) {
    const opener = fenceOpener(lines[index]!);
    if (!opener) {
      output.push({ text: lines[index]!, fenced: false });
      continue;
    }
    let close = index + 1;
    for (; close < lines.length; close++) {
      if (closesFence(lines[close]!, opener.marker, opener.length)) break;
    }
    if (close >= lines.length) {
      // Unclosed: copy the rest verbatim.
      for (let rest = index; rest < lines.length; rest++) output.push({ text: lines[rest]!, fenced: true });
      break;
    }
    const body = lines.slice(index + 1, close);
    const bodyText = body.join("\n");
    const cut =
      bodyText.length > FENCED_BLOCK_MAX_CHARS &&
      body.length > HEAD_LINES + TAIL_LINES &&
      !OMISSION_MARKER.test(bodyText);
    output.push({ text: lines[index]!, fenced: true });
    if (cut) {
      for (const line of cutLines(body, HEAD_LINES, TAIL_LINES)) output.push({ text: line, fenced: true });
    } else {
      for (const line of body) output.push({ text: line, fenced: true });
    }
    output.push({ text: lines[close]!, fenced: true });
    index = close;
  }
  return output;
}

const TIMESTAMP = [
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/,
  /^\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/,
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[ ,]/,
  /^[A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2}/,
];

const looksLikeLogOrData = (line: string): boolean => {
  const text = line.trimStart();
  if (text.startsWith("{") || text.startsWith("[") || text.startsWith('"')) return true;
  return TIMESTAMP.some((pattern) => pattern.test(text));
};

/** Cut an unfenced run of more than 200 consecutive log/JSON lines the same
 *  way: first 20 and last 5 lines, with the rest counted. Prose is never
 *  matched as a run because most of its lines start with an ordinary word. */
function cutLogRuns(lines: readonly SourceLine[]): SourceLine[] {
  const output: SourceLine[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.fenced || !line.text.trim()) {
      output.push(line);
      index++;
      continue;
    }
    let end = index;
    let qualifying = 0;
    while (end < lines.length && !lines[end]!.fenced && lines[end]!.text.trim()) {
      if (looksLikeLogOrData(lines[end]!.text)) qualifying++;
      end++;
    }
    const count = end - index;
    if (count > LOG_RUN_MAX_LINES && qualifying * 2 > count) {
      const run = lines.slice(index, end).map((entry) => entry.text);
      for (const text of cutLines(run, HEAD_LINES, TAIL_LINES)) output.push({ text, fenced: false });
    } else {
      for (let at = index; at < end; at++) output.push(lines[at]!);
    }
    index = end;
  }
  return output;
}

/** Dense message content replaced with a size marker for the compaction
 *  summarizer. Prose, short code and URLs pass through; applying it twice
 *  gives the same result as once, and it scans the text linearly. */
export function stripDenseContent(text: string): string {
  if (!text) return text;
  const inline = stripInlineDense(text);
  const lines = cutLogRuns(cutFencedBlocks(inline.split("\n")));
  return lines.map((line) => line.text).join("\n");
}
