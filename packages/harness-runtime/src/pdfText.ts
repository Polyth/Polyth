// Bounded text-layer extraction for PDF attachments. Polyth delivers a PDF to
// a harness or model that cannot take one natively by projecting this text
// into the prompt, so every engine can read an ordinary PDF.
//
// The file is untrusted input. The extractor never trusts the xref table (it
// scans for objects, which also survives broken offsets), never executes
// anything, caps input size, per-stream and total decoded bytes, object count,
// page count, recursion depth and output length, and fails closed with a
// reason instead of guessing. It reads the text layer only: a scan has none,
// and an encrypted file is refused rather than decrypted.
import { constants as zlibConstants, inflateRawSync, inflateSync } from "node:zlib";

export const PDF_TEXT_MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const MAX_DECODED_BYTES = 192 * 1024 * 1024;
const MAX_OBJECTS = 500_000;
const MAX_PAGES = 5_000;
const MAX_DEPTH = 32;
const MAX_CMAP_ENTRIES = 300_000;
const DEFAULT_MAX_CHARS = 1_000_000;

export type PdfTextFailure = "malformed" | "encrypted" | "no-text" | "too-large";

export type PdfTextResult =
  | { ok: true; pages: string[]; pageCount: number; truncated: boolean }
  | { ok: false; reason: PdfTextFailure };

// ------------------------------------------------------------------ values

interface PdfName { kind: "name"; name: string }
interface PdfString { kind: "string"; bytes: Uint8Array }
interface PdfRef { kind: "ref"; num: number }
interface PdfDict { kind: "dict"; entries: Map<string, PdfValue> }
type PdfValue = number | boolean | null | PdfName | PdfString | PdfRef | PdfDict | PdfValue[];

interface PdfObject {
  value: PdfValue;
  /** Byte offset of the definition; a later definition wins (incremental updates). */
  offset: number;
  stream?: { start: number; end: number };
  /** Decoded bytes of an object-stream member's container are cached here. */
  decoded?: Uint8Array | null;
}

class PdfLimitError extends Error {}

const isName = (value: PdfValue | undefined, name?: string): value is PdfName =>
  typeof value === "object" && value !== null && !Array.isArray(value) && value.kind === "name"
  && (name === undefined || value.name === name);
const isDict = (value: PdfValue | undefined): value is PdfDict =>
  typeof value === "object" && value !== null && !Array.isArray(value) && value.kind === "dict";
const isString = (value: PdfValue | undefined): value is PdfString =>
  typeof value === "object" && value !== null && !Array.isArray(value) && value.kind === "string";
const isRef = (value: PdfValue | undefined): value is PdfRef =>
  typeof value === "object" && value !== null && !Array.isArray(value) && value.kind === "ref";

// ------------------------------------------------------------------- lexer

const isWhite = (c: number): boolean => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isDelim = (c: number): boolean =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d
  || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
const isRegular = (c: number): boolean => !isWhite(c) && !isDelim(c);
const hexValue = (c: number): number =>
  c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1;

const ESCAPES: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 };

type Token =
  | { type: "value"; value: PdfValue }
  | { type: "keyword"; word: string }
  | { type: "open-dict" } | { type: "close-dict" }
  | { type: "open-array" } | { type: "close-array" }
  | { type: "eof" };

const latin1 = (bytes: Uint8Array, start: number, end: number): string => {
  let out = "";
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]!);
  return out;
};

class Lexer {
  pos: number;
  readonly buf: Uint8Array;
  readonly end: number;
  constructor(buf: Uint8Array, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
  }

  skipWhite(): void {
    const { buf, end } = this;
    while (this.pos < end) {
      const c = buf[this.pos]!;
      if (isWhite(c)) { this.pos++; continue; }
      if (c === 0x25) {
        while (this.pos < end && buf[this.pos] !== 10 && buf[this.pos] !== 13) this.pos++;
        continue;
      }
      break;
    }
  }

  next(): Token {
    this.skipWhite();
    const { buf, end } = this;
    if (this.pos >= end) return { type: "eof" };
    const c = buf[this.pos]!;
    if (c === 0x2f) return { type: "value", value: this.name() };
    if (c === 0x28) return { type: "value", value: this.literal() };
    if (c === 0x3c) {
      if (buf[this.pos + 1] === 0x3c) { this.pos += 2; return { type: "open-dict" }; }
      return { type: "value", value: this.hex() };
    }
    if (c === 0x3e) {
      this.pos += buf[this.pos + 1] === 0x3e ? 2 : 1;
      return { type: "close-dict" };
    }
    if (c === 0x5b) { this.pos++; return { type: "open-array" }; }
    if (c === 0x5d) { this.pos++; return { type: "close-array" }; }
    if (c === 0x7b || c === 0x7d || c === 0x29) {
      // Stray delimiters (PostScript braces, unbalanced parens) carry no text.
      this.pos++;
      return { type: "keyword", word: String.fromCharCode(c) };
    }
    const start = this.pos;
    while (this.pos < end && isRegular(buf[this.pos]!)) this.pos++;
    const word = latin1(buf, start, this.pos);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { type: "value", value: Number(word) };
    if (/^[+-]?\d*\.?\d*[+-]\d*$/.test(word) && /\d/.test(word)) {
      // Malformed numbers such as "0.00-12" appear in the wild; keep the head.
      const head = Number.parseFloat(word);
      return { type: "value", value: Number.isFinite(head) ? head : 0 };
    }
    if (word === "true") return { type: "value", value: true };
    if (word === "false") return { type: "value", value: false };
    if (word === "null") return { type: "value", value: null };
    return { type: "keyword", word };
  }

  private name(): PdfName {
    const { buf, end } = this;
    this.pos++;
    let out = "";
    while (this.pos < end && isRegular(buf[this.pos]!)) {
      const c = buf[this.pos]!;
      if (c === 0x23 && this.pos + 2 < end) {
        const hi = hexValue(buf[this.pos + 1]!);
        const lo = hexValue(buf[this.pos + 2]!);
        if (hi >= 0 && lo >= 0) {
          out += String.fromCharCode(hi * 16 + lo);
          this.pos += 3;
          continue;
        }
      }
      out += String.fromCharCode(c);
      this.pos++;
    }
    return { kind: "name", name: out };
  }

  private literal(): PdfString {
    const { buf, end } = this;
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < end) {
      let c = buf[this.pos++]!;
      if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) break;
      else if (c === 0x5c) {
        if (this.pos >= end) break;
        c = buf[this.pos++]!;
        const escaped = ESCAPES[c];
        if (escaped !== undefined) { out.push(escaped); continue; }
        if (c === 13) { if (buf[this.pos] === 10) this.pos++; continue; }
        if (c === 10) continue;
        if (c >= 0x30 && c <= 0x37) {
          let value = c - 0x30;
          for (let n = 0; n < 2 && this.pos < end; n++) {
            const d = buf[this.pos]!;
            if (d < 0x30 || d > 0x37) break;
            value = value * 8 + d - 0x30;
            this.pos++;
          }
          out.push(value & 0xff);
          continue;
        }
        out.push(c);
        continue;
      } else if (c === 13) {
        if (buf[this.pos] === 10) this.pos++;
        c = 10;
      }
      out.push(c);
    }
    return { kind: "string", bytes: Uint8Array.from(out) };
  }

  private hex(): PdfString {
    const { buf, end } = this;
    this.pos++;
    const out: number[] = [];
    let pending = -1;
    while (this.pos < end) {
      const c = buf[this.pos++]!;
      if (c === 0x3e) break;
      const value = hexValue(c);
      if (value < 0) continue;
      if (pending < 0) pending = value;
      else { out.push(pending * 16 + value); pending = -1; }
    }
    if (pending >= 0) out.push(pending * 16);
    return { kind: "string", bytes: Uint8Array.from(out) };
  }
}

/** Parse one value. `refs` enables `n g R` references (off in content streams). */
const parseValue = (lexer: Lexer, refs: boolean, depth = 0, first?: Token): PdfValue | undefined => {
  if (depth > MAX_DEPTH) throw new PdfLimitError("nesting");
  const token = first ?? lexer.next();
  if (token.type === "value") {
    if (refs && typeof token.value === "number" && Number.isInteger(token.value) && token.value >= 0) {
      const save = lexer.pos;
      const gen = lexer.next();
      if (gen.type === "value" && typeof gen.value === "number" && Number.isInteger(gen.value)) {
        const r = lexer.next();
        if (r.type === "keyword" && r.word === "R") return { kind: "ref", num: token.value };
      }
      lexer.pos = save;
    }
    return token.value;
  }
  if (token.type === "open-array") {
    const items: PdfValue[] = [];
    for (;;) {
      const next = lexer.next();
      if (next.type === "close-array" || next.type === "eof") return items;
      if (next.type === "keyword" && (next.word === "endobj" || next.word === "stream")) {
        lexer.pos -= next.word.length;
        return items;
      }
      const value = parseValue(lexer, refs, depth + 1, next);
      if (value !== undefined) items.push(value);
    }
  }
  if (token.type === "open-dict") {
    const entries = new Map<string, PdfValue>();
    for (;;) {
      const key = lexer.next();
      if (key.type === "close-dict" || key.type === "eof") break;
      if (key.type === "keyword" && (key.word === "endobj" || key.word === "stream")) {
        lexer.pos -= key.word.length;
        break;
      }
      if (key.type !== "value" || !isName(key.value)) continue;
      const value = parseValue(lexer, refs, depth + 1);
      if (value !== undefined) entries.set(key.value.name, value);
    }
    return { kind: "dict", entries };
  }
  return undefined;
};

// ----------------------------------------------------------------- filters

class Budget {
  used = 0;
  take(bytes: number): void {
    this.used += bytes;
    if (this.used > MAX_DECODED_BYTES) throw new PdfLimitError("decoded");
  }
}

const inflate = (data: Uint8Array): Uint8Array => {
  const options = { maxOutputLength: MAX_STREAM_BYTES };
  try {
    return inflateSync(data, options);
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new PdfLimitError("stream");
  }
  // Truncated or slightly corrupt streams are common; keep what decodes.
  try {
    return inflateSync(data, { ...options, finishFlush: zlibConstants.Z_SYNC_FLUSH });
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new PdfLimitError("stream");
  }
  return inflateRawSync(data, { ...options, finishFlush: zlibConstants.Z_SYNC_FLUSH });
};

const asciiHex = (data: Uint8Array): Uint8Array => {
  const out: number[] = [];
  let pending = -1;
  for (const c of data) {
    if (c === 0x3e) break;
    const value = hexValue(c);
    if (value < 0) continue;
    if (pending < 0) pending = value;
    else { out.push(pending * 16 + value); pending = -1; }
  }
  if (pending >= 0) out.push(pending * 16);
  return Uint8Array.from(out);
};

const ascii85 = (data: Uint8Array): Uint8Array => {
  const out: number[] = [];
  const group: number[] = [];
  const flush = (count: number): void => {
    let value = 0;
    for (let i = 0; i < 5; i++) value = value * 85 + (group[i] ?? 84);
    const bytes = [value >>> 24 & 0xff, value >>> 16 & 0xff, value >>> 8 & 0xff, value & 0xff];
    out.push(...bytes.slice(0, count));
  };
  let i = data[0] === 0x3c && data[1] === 0x7e ? 2 : 0;
  for (; i < data.length; i++) {
    const c = data[i]!;
    if (c === 0x7e) break;
    if (isWhite(c)) continue;
    if (c === 0x7a && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    if (c < 0x21 || c > 0x75) continue;
    group.push(c - 0x21);
    if (group.length === 5) { flush(4); group.length = 0; }
  }
  if (group.length > 1) flush(group.length - 1);
  return Uint8Array.from(out);
};

const lzw = (data: Uint8Array, earlyChange: number): Uint8Array => {
  const out: number[] = [];
  let table: Uint8Array[] = [];
  const reset = (): void => {
    table = [];
    for (let i = 0; i < 256; i++) table.push(Uint8Array.of(i));
    table.push(new Uint8Array(0), new Uint8Array(0));
  };
  reset();
  let codeLength = 9;
  let previous: Uint8Array | undefined;
  let bitBuffer = 0;
  let bitCount = 0;
  for (const byte of data) {
    bitBuffer = (bitBuffer << 8 | byte) >>> 0;
    bitCount += 8;
    while (bitCount >= codeLength) {
      const code = bitBuffer >>> (bitCount - codeLength) & ((1 << codeLength) - 1);
      bitCount -= codeLength;
      bitBuffer &= (1 << bitCount) - 1;
      if (code === 256) { reset(); codeLength = 9; previous = undefined; continue; }
      if (code === 257) return Uint8Array.from(out);
      let entry: Uint8Array;
      if (code < table.length) entry = table[code]!;
      else if (code === table.length && previous) {
        entry = new Uint8Array(previous.length + 1);
        entry.set(previous);
        entry[previous.length] = previous[0]!;
      } else return Uint8Array.from(out);
      if (out.length + entry.length > MAX_STREAM_BYTES) throw new PdfLimitError("stream");
      for (const b of entry) out.push(b);
      if (previous && table.length < 4096) {
        const added = new Uint8Array(previous.length + 1);
        added.set(previous);
        added[previous.length] = entry[0]!;
        table.push(added);
      }
      previous = entry;
      if (table.length + earlyChange >= 1 << codeLength && codeLength < 12) codeLength++;
    }
  }
  return Uint8Array.from(out);
};

const runLength = (data: Uint8Array): Uint8Array => {
  const out: number[] = [];
  for (let i = 0; i < data.length;) {
    const length = data[i++]!;
    if (length === 128) break;
    if (length < 128) {
      for (let n = 0; n <= length && i < data.length; n++) out.push(data[i++]!);
    } else {
      const value = data[i++] ?? 0;
      for (let n = 0; n < 257 - length; n++) out.push(value);
    }
    if (out.length > MAX_STREAM_BYTES) throw new PdfLimitError("stream");
  }
  return Uint8Array.from(out);
};

// ---------------------------------------------------------------- document

class PdfDocument {
  readonly bytes: Uint8Array;
  readonly objects = new Map<number, PdfObject>();
  readonly trailers: PdfDict[] = [];
  readonly budget = new Budget();

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  scan(): void {
    const { bytes } = this;
    const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
    const pattern = /(\d{1,10})[\0\t\n\f\r ]+\d{1,5}[\0\t\n\f\r ]+obj(?![A-Za-z0-9])|trailer(?![A-Za-z0-9])/g;
    let count = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      if (match.index > 0 && isRegular(bytes[match.index - 1]!) && match[1] !== undefined) continue;
      const lexer = new Lexer(bytes, match.index + match[0].length);
      if (match[1] === undefined) {
        const value = parseValue(lexer, true);
        if (isDict(value)) this.trailers.push(value);
        pattern.lastIndex = lexer.pos;
        continue;
      }
      if (++count > MAX_OBJECTS) throw new PdfLimitError("objects");
      const value = parseValue(lexer, true) ?? null;
      const object: PdfObject = { value, offset: match.index };
      lexer.skipWhite();
      if (isDict(value) && text.startsWith("stream", lexer.pos)) {
        let start = lexer.pos + 6;
        if (bytes[start] === 13) start++;
        if (bytes[start] === 10) start++;
        const declared = value.entries.get("Length");
        let end = -1;
        if (typeof declared === "number" && declared >= 0 && start + declared <= bytes.length) {
          const after = new Lexer(bytes, start + declared);
          after.skipWhite();
          if (text.startsWith("endstream", after.pos)) end = start + declared;
        }
        if (end < 0) {
          const found = text.indexOf("endstream", start);
          end = found < 0 ? bytes.length : found;
          while (end > start && (bytes[end - 1] === 10 || bytes[end - 1] === 13)) end--;
        }
        object.stream = { start, end };
        pattern.lastIndex = end;
      } else {
        pattern.lastIndex = lexer.pos;
      }
      if (isDict(value) && isName(value.entries.get("Type"), "XRef")) this.trailers.push(value);
      this.define(Number(match[1]), object);
    }
    this.expandObjectStreams();
  }

  private define(num: number, object: PdfObject): void {
    const current = this.objects.get(num);
    if (!current || current.offset <= object.offset) this.objects.set(num, object);
  }

  private expandObjectStreams(): void {
    for (const object of [...this.objects.values()]) {
      if (!isDict(object.value) || !isName(object.value.entries.get("Type"), "ObjStm")) continue;
      const data = this.streamData(object);
      if (!data) continue;
      const n = this.resolve(object.value.entries.get("N"));
      const first = this.resolve(object.value.entries.get("First"));
      if (typeof n !== "number" || typeof first !== "number") continue;
      const header = new Lexer(data, 0, Math.min(first, data.length));
      const members: Array<[number, number]> = [];
      for (let i = 0; i < n && i < MAX_OBJECTS; i++) {
        const num = header.next();
        const offset = header.next();
        if (num.type !== "value" || offset.type !== "value") break;
        if (typeof num.value !== "number" || typeof offset.value !== "number") break;
        members.push([num.value, offset.value]);
      }
      for (const [num, offset] of members) {
        const lexer = new Lexer(data, first + offset);
        const value = parseValue(lexer, true) ?? null;
        this.define(num, { value, offset: object.offset });
      }
    }
  }

  resolve(value: PdfValue | undefined, hops = 0): PdfValue | undefined {
    if (!isRef(value)) return value;
    if (hops > 8) return undefined;
    return this.resolve(this.objects.get(value.num)?.value, hops + 1);
  }

  dict(value: PdfValue | undefined): PdfDict | undefined {
    const resolved = this.resolve(value);
    return isDict(resolved) ? resolved : undefined;
  }

  get(dict: PdfDict | undefined, key: string): PdfValue | undefined {
    return dict ? this.resolve(dict.entries.get(key)) : undefined;
  }

  objectOf(value: PdfValue | undefined): PdfObject | undefined {
    return isRef(value) ? this.objects.get(value.num) : undefined;
  }

  /** Decoded bytes of a stream object, or undefined for image/unknown filters. */
  streamData(object: PdfObject | undefined): Uint8Array | undefined {
    if (!object?.stream || !isDict(object.value)) return undefined;
    if (object.decoded !== undefined) return object.decoded ?? undefined;
    const dict = object.value;
    const filterValue = this.get(dict, "Filter");
    const paramsValue = this.get(dict, "DecodeParms");
    const filters = Array.isArray(filterValue) ? filterValue.map((item) => this.resolve(item)) : [filterValue];
    const params = Array.isArray(paramsValue) ? paramsValue.map((item) => this.resolve(item)) : [paramsValue];
    let data: Uint8Array = this.bytes.subarray(object.stream.start, object.stream.end);
    try {
      for (let index = 0; index < filters.length; index++) {
        const filter = filters[index];
        if (filter === undefined || filter === null) continue;
        if (!isName(filter)) { object.decoded = null; return undefined; }
        const param = isDict(params[index]) ? params[index] as PdfDict : undefined;
        const predictor = this.get(param, "Predictor");
        if (typeof predictor === "number" && predictor > 1) { object.decoded = null; return undefined; }
        switch (filter.name) {
          case "FlateDecode": case "Fl": data = inflate(data); break;
          case "ASCIIHexDecode": case "AHx": data = asciiHex(data); break;
          case "ASCII85Decode": case "A85": data = ascii85(data); break;
          case "LZWDecode": case "LZW": {
            const early = this.get(param, "EarlyChange");
            data = lzw(data, typeof early === "number" ? early : 1);
            break;
          }
          case "RunLengthDecode": case "RL": data = runLength(data); break;
          default: object.decoded = null; return undefined;
        }
        if (data.length > MAX_STREAM_BYTES) throw new PdfLimitError("stream");
      }
    } catch (error) {
      if (error instanceof PdfLimitError) throw error;
      object.decoded = null;
      return undefined;
    }
    this.budget.take(data.length);
    object.decoded = data;
    return data;
  }

  encrypted(): boolean {
    return this.trailers.some((trailer) => trailer.entries.has("Encrypt"));
  }

  /** Page dictionaries in document order, each with its inherited resources. */
  pages(): Array<{ page: PdfDict; resources: PdfDict | undefined }> {
    const pages: Array<{ page: PdfDict; resources: PdfDict | undefined }> = [];
    const seen = new Set<PdfDict>();
    const walk = (node: PdfDict | undefined, inherited: PdfDict | undefined, depth: number): void => {
      if (!node || seen.has(node) || depth > MAX_DEPTH || pages.length >= MAX_PAGES) return;
      seen.add(node);
      const resources = this.dict(node.entries.get("Resources")) ?? inherited;
      const kids = this.get(node, "Kids");
      if (Array.isArray(kids) && !isName(this.get(node, "Type"), "Page")) {
        for (const kid of kids) walk(this.dict(kid), resources, depth + 1);
        return;
      }
      pages.push({ page: node, resources });
    };
    const catalogs = this.trailers.map((trailer) => this.dict(trailer.entries.get("Root")))
      .filter((catalog): catalog is PdfDict => !!catalog);
    if (!catalogs.length) {
      for (const object of this.objects.values()) {
        if (isDict(object.value) && isName(object.value.entries.get("Type"), "Catalog")) catalogs.push(object.value);
      }
    }
    for (const catalog of catalogs.reverse()) {
      walk(this.dict(catalog.entries.get("Pages")), undefined, 0);
      if (pages.length) return pages;
    }
    // No usable page tree: fall back to every page object in object order.
    const loose = [...this.objects.entries()]
      .filter(([, object]) => isDict(object.value) && isName(object.value.entries.get("Type"), "Page"))
      .sort(([a], [b]) => a - b);
    for (const [, object] of loose.slice(0, MAX_PAGES)) {
      const page = object.value as PdfDict;
      pages.push({ page, resources: this.dict(page.entries.get("Resources")) });
    }
    return pages;
  }

  /** The page's content streams, concatenated as the spec requires. */
  contents(dict: PdfDict): Uint8Array | undefined {
    const value = dict.entries.get("Contents");
    const parts = (Array.isArray(value) ? value : Array.isArray(this.resolve(value)) ? this.resolve(value) as PdfValue[] : [value])
      .map((item) => this.streamData(this.objectOf(item)))
      .filter((part): part is Uint8Array => !!part);
    if (!parts.length) return undefined;
    if (parts.length === 1) return parts[0];
    const total = parts.reduce((sum, part) => sum + part.length + 1, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      joined[offset + part.length] = 10;
      offset += part.length + 1;
    }
    return joined;
  }
}

// ------------------------------------------------------------------- fonts

const WIN_ANSI_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

const STANDARD_HIGH: Record<number, number> = {
  0x27: 0x2019, 0x60: 0x2018, 0xa1: 0xa1, 0xa2: 0xa2, 0xa3: 0xa3, 0xa4: 0x2044, 0xa5: 0xa5, 0xa6: 0x0192,
  0xa7: 0xa7, 0xa8: 0xa4, 0xa9: 0x27, 0xaa: 0x201c, 0xab: 0xab, 0xac: 0x2039, 0xad: 0x203a, 0xae: 0xfb01,
  0xaf: 0xfb02, 0xb1: 0x2013, 0xb2: 0x2020, 0xb3: 0x2021, 0xb4: 0xb7, 0xb6: 0xb6, 0xb7: 0x2022,
  0xb8: 0x201a, 0xb9: 0x201e, 0xba: 0x201d, 0xbb: 0xbb, 0xbc: 0x2026, 0xbd: 0x2030, 0xbf: 0xbf,
  0xc1: 0x60, 0xc2: 0xb4, 0xc3: 0x02c6, 0xc4: 0x02dc, 0xc5: 0xaf, 0xc6: 0x02d8, 0xc7: 0x02d9, 0xc8: 0xa8,
  0xca: 0x02da, 0xcb: 0xb8, 0xcd: 0x02dd, 0xce: 0x02db, 0xcf: 0x02c7, 0xd0: 0x2014, 0xe1: 0xc6, 0xe3: 0xaa,
  0xe8: 0x0141, 0xe9: 0xd8, 0xea: 0x0152, 0xeb: 0xba, 0xf1: 0xe6, 0xf5: 0x0131, 0xf8: 0x0142, 0xf9: 0xf8,
  0xfa: 0x0153, 0xfb: 0xdf,
};

let macRoman: string[] | undefined;
const baseEncoding = (name: string | undefined): string[] => {
  const table: string[] = [];
  if (name === "MacRomanEncoding") {
    if (!macRoman) {
      try {
        const decoder = new TextDecoder("macintosh");
        macRoman = Array.from({ length: 256 }, (_, code) => code < 0x20 ? "" : decoder.decode(Uint8Array.of(code)));
      } catch {
        macRoman = Array.from({ length: 256 }, (_, code) => code < 0x20 || code > 0x7e ? "" : String.fromCharCode(code));
      }
    }
    return [...macRoman];
  }
  const standard = name !== "WinAnsiEncoding";
  for (let code = 0; code < 256; code++) {
    if (code < 0x20) { table.push(""); continue; }
    if (standard) {
      const mapped = STANDARD_HIGH[code];
      table.push(mapped !== undefined ? String.fromCodePoint(mapped) : code <= 0x7e ? String.fromCharCode(code) : "");
      continue;
    }
    if (code >= 0x80 && code <= 0x9f) {
      const mapped = WIN_ANSI_HIGH[code];
      table.push(mapped !== undefined ? String.fromCodePoint(mapped) : "");
      continue;
    }
    table.push(code === 0x7f ? "" : code === 0xad ? "-" : String.fromCharCode(code));
  }
  return table;
};

const NAMED_GLYPHS: Record<string, string> = {
  space: " ", exclam: "!", quotedbl: "\"", numbersign: "#", dollar: "$", percent: "%", ampersand: "&",
  quotesingle: "'", quoteright: "’", quoteleft: "‘", parenleft: "(", parenright: ")",
  asterisk: "*", plus: "+", comma: ",", hyphen: "-", period: ".", slash: "/", colon: ":", semicolon: ";",
  less: "<", equal: "=", greater: ">", question: "?", at: "@", bracketleft: "[", backslash: "\\",
  bracketright: "]", asciicircum: "^", underscore: "_", grave: "`", braceleft: "{", bar: "|",
  braceright: "}", asciitilde: "~", zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", bullet: "•", endash: "–", emdash: "—",
  quotedblleft: "“", quotedblright: "”", quotesinglbase: "‚", quotedblbase: "„",
  ellipsis: "…", dagger: "†", daggerdbl: "‡", perthousand: "‰", trademark: "™",
  copyright: "©", registered: "®", degree: "°", section: "§", paragraph: "¶",
  fi: "fi", fl: "fl", ff: "ff", ffi: "ffi", ffl: "ffl", minus: "−", multiply: "×",
  divide: "÷", plusminus: "±", Euro: "€", nbspace: " ", nonbreakingspace: " ",
  exclamdown: "¡", cent: "¢", sterling: "£", yen: "¥", currency: "¤",
  brokenbar: "¦", dieresis: "¨", ordfeminine: "ª", guillemotleft: "«",
  logicalnot: "¬", macron: "¯", acute: "´", mu: "µ", periodcentered: "·",
  cedilla: "¸", ordmasculine: "º", guillemotright: "»", onequarter: "¼",
  onehalf: "½", threequarters: "¾", questiondown: "¿", germandbls: "ß",
  AE: "Æ", ae: "æ", OE: "Œ", oe: "œ", Oslash: "Ø", oslash: "ø",
  Lslash: "Ł", lslash: "ł", dotlessi: "ı", circumflex: "ˆ", tilde: "˜",
  florin: "ƒ", guilsinglleft: "‹", guilsinglright: "›", fraction: "⁄",
  ring: "˚", caron: "ˇ", breve: "˘", dotaccent: "˙", hungarumlaut: "˝",
  ogonek: "˛", Eth: "Ð", eth: "ð", Thorn: "Þ", thorn: "þ",
  onesuperior: "¹", twosuperior: "²", threesuperior: "³", softhyphen: "-",
  afii10050: "Ґ", afii10053: "Є", afii10055: "І", afii10056: "Ї",
  afii10098: "ґ", afii10101: "є", afii10103: "і", afii10104: "ї",
  afii61352: "№",
};

// AGL afii10017..afii10049 and afii10065..afii10097: the Russian alphabet with Ё
// in its alphabetical slot, which is why it is not a contiguous code range.
const CYRILLIC_ORDER = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ";
for (let i = 0; i < CYRILLIC_ORDER.length; i++) {
  NAMED_GLYPHS[`afii${10017 + i}`] = CYRILLIC_ORDER[i]!;
  NAMED_GLYPHS[`afii${10065 + i}`] = CYRILLIC_ORDER[i]!.toLowerCase();
}

const ACCENTS: Record<string, string> = {
  acute: "́", grave: "̀", circumflex: "̂", tilde: "̃", dieresis: "̈",
  ring: "̊", cedilla: "̧", caron: "̌", breve: "̆", macron: "̄",
  ogonek: "̨", dotaccent: "̇", hungarumlaut: "̋", commaaccent: "̦",
};

const glyphToUnicode = (raw: string): string | undefined => {
  const name = raw.split(".")[0]!;
  if (!name) return undefined;
  if (name.includes("_")) {
    const parts = name.split("_").map(glyphToUnicode);
    return parts.every((part) => part !== undefined) ? parts.join("") : undefined;
  }
  const named = NAMED_GLYPHS[name];
  if (named !== undefined) return named;
  if (/^[A-Za-z]$/.test(name)) return name;
  const uni = /^uni((?:[0-9A-F]{4})+)$/.exec(name);
  if (uni) {
    const units = uni[1]!.match(/.{4}/g)!.map((unit) => Number.parseInt(unit, 16));
    return String.fromCharCode(...units);
  }
  const u = /^u([0-9A-F]{4,6})$/.exec(name);
  if (u) {
    const code = Number.parseInt(u[1]!, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : undefined;
  }
  const accented = /^([A-Za-z])([a-z]+)$/.exec(name);
  if (accented && ACCENTS[accented[2]!]) return `${accented[1]}${ACCENTS[accented[2]!]}`.normalize("NFC");
  return undefined;
};

const utf16be = (bytes: Uint8Array): string => {
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes[i]! << 8 | bytes[i + 1]!);
  return out;
};

const codeOf = (bytes: Uint8Array, start: number, length: number): number => {
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + (bytes[start + i] ?? 0);
  return value;
};
const codeKey = (length: number, value: number): number => length * 0x1_0000_0000 + value;

interface CMap {
  /** Byte lengths of codespace ranges: [length, low, high]. */
  codespace: Array<[number, number, number]>;
  map: Map<number, string>;
  maxLength: number;
}

const parseCMap = (data: Uint8Array): CMap => {
  const lexer = new Lexer(data);
  const cmap: CMap = { codespace: [], map: new Map(), maxLength: 0 };
  const operands: PdfValue[] = [];
  let mode = "";
  let guard = 0;
  for (;;) {
    if (++guard > 4 * MAX_CMAP_ENTRIES) break;
    const token = lexer.next();
    if (token.type === "eof") break;
    if (token.type === "keyword") {
      if (token.word.startsWith("begin")) { mode = token.word; operands.length = 0; continue; }
      if (token.word.startsWith("end")) { mode = ""; operands.length = 0; continue; }
      operands.length = 0;
      continue;
    }
    const value = parseValue(lexer, false, 0, token);
    if (value === undefined) continue;
    operands.push(value);
    if (mode === "begincodespacerange" && operands.length === 2) {
      const [low, high] = operands as [PdfValue, PdfValue];
      if (isString(low) && isString(high) && low.bytes.length >= 1 && low.bytes.length <= 4) {
        cmap.codespace.push([low.bytes.length, codeOf(low.bytes, 0, low.bytes.length), codeOf(high.bytes, 0, low.bytes.length)]);
      }
      operands.length = 0;
    } else if (mode === "beginbfchar" && operands.length === 2) {
      const [source, target] = operands as [PdfValue, PdfValue];
      if (isString(source) && source.bytes.length >= 1 && source.bytes.length <= 4 && cmap.map.size < MAX_CMAP_ENTRIES) {
        const text = isString(target) ? utf16be(target.bytes) : isName(target) ? glyphToUnicode(target.name) ?? "" : "";
        cmap.map.set(codeKey(source.bytes.length, codeOf(source.bytes, 0, source.bytes.length)), text);
        cmap.maxLength = Math.max(cmap.maxLength, source.bytes.length);
      }
      operands.length = 0;
    } else if (mode === "beginbfrange" && operands.length === 3) {
      const [low, high, target] = operands as [PdfValue, PdfValue, PdfValue];
      operands.length = 0;
      if (!isString(low) || !isString(high) || low.bytes.length < 1 || low.bytes.length > 4) continue;
      const length = low.bytes.length;
      const from = codeOf(low.bytes, 0, length);
      const to = Math.min(codeOf(high.bytes, 0, length), from + 0xffff);
      cmap.maxLength = Math.max(cmap.maxLength, length);
      for (let code = from; code <= to && cmap.map.size < MAX_CMAP_ENTRIES; code++) {
        let text = "";
        if (Array.isArray(target)) {
          const item = target[code - from];
          text = isString(item) ? utf16be(item.bytes) : "";
        } else if (isString(target) && target.bytes.length >= 2) {
          const bytes = Uint8Array.from(target.bytes);
          const last = (bytes[bytes.length - 2]! << 8 | bytes[bytes.length - 1]!) + code - from;
          bytes[bytes.length - 2] = last >> 8 & 0xff;
          bytes[bytes.length - 1] = last & 0xff;
          text = utf16be(bytes);
        }
        cmap.map.set(codeKey(length, code), text);
      }
    }
  }
  return cmap;
};

interface Glyph { text: string; width: number; space: boolean }

interface Font {
  /** Split shown bytes into glyphs; width is in glyph space (1/1000 em). */
  glyphs(bytes: Uint8Array): Glyph[];
}

class FontCache {
  private readonly fonts = new Map<PdfDict, Font>();
  readonly doc: PdfDocument;
  constructor(doc: PdfDocument) {
    this.doc = doc;
  }

  font(dict: PdfDict | undefined): Font {
    if (!dict) return FALLBACK_FONT;
    const cached = this.fonts.get(dict);
    if (cached) return cached;
    const font = this.build(dict);
    this.fonts.set(dict, font);
    return font;
  }

  private build(dict: PdfDict): Font {
    const doc = this.doc;
    const subtype = doc.get(dict, "Subtype");
    const toUnicodeData = doc.streamData(doc.objectOf(dict.entries.get("ToUnicode")));
    const cmap = toUnicodeData ? parseCMap(toUnicodeData) : undefined;
    if (isName(subtype, "Type0")) {
      const encoding = doc.get(dict, "Encoding");
      const encodingName = isName(encoding) ? encoding.name : "";
      const ucs2 = /^Uni.*(UCS2|UTF16)/.test(encodingName);
      const descendants = doc.get(dict, "DescendantFonts");
      const descendant = doc.dict(Array.isArray(descendants) ? descendants[0] : undefined);
      const widths = cidWidths(doc, descendant);
      const codespace = cmap?.codespace.length ? cmap.codespace : [[2, 0, 0xffff] as [number, number, number]];
      return {
        glyphs: (bytes) => {
          const glyphs: Glyph[] = [];
          for (let i = 0; i < bytes.length;) {
            const length = codeLength(codespace, bytes, i, 2);
            const code = codeOf(bytes, i, length);
            i += length;
            const text = cmap?.map.get(codeKey(length, code)) ?? (ucs2 ? String.fromCharCode(code) : "");
            glyphs.push({ text, width: widths.get(code) ?? widths.fallback, space: false });
          }
          return glyphs;
        },
      };
    }
    const encoding = doc.get(dict, "Encoding");
    const encodingDict = isDict(encoding) ? encoding : undefined;
    const baseName = isName(encoding) ? encoding.name
      : encodingDict && isName(doc.get(encodingDict, "BaseEncoding")) ? (doc.get(encodingDict, "BaseEncoding") as PdfName).name
        : isName(subtype, "TrueType") ? "WinAnsiEncoding" : "StandardEncoding";
    const table = baseEncoding(baseName);
    const differences = doc.get(encodingDict, "Differences");
    if (Array.isArray(differences)) {
      let code = 0;
      for (const item of differences) {
        const value = doc.resolve(item);
        if (typeof value === "number") code = Math.trunc(value);
        else if (isName(value) && code >= 0 && code < 256) table[code++] = glyphToUnicode(value.name) ?? "";
      }
    }
    const firstChar = doc.get(dict, "FirstChar");
    const widthArray = doc.get(dict, "Widths");
    const descriptor = doc.dict(dict.entries.get("FontDescriptor"));
    const missing = doc.get(descriptor, "MissingWidth");
    const fallbackWidth = typeof missing === "number" && missing > 0 ? missing : 500;
    const singleWidths = new Map<number, number>();
    if (Array.isArray(widthArray) && typeof firstChar === "number") {
      widthArray.forEach((width, index) => {
        const resolved = doc.resolve(width);
        if (typeof resolved === "number") singleWidths.set(firstChar + index, resolved);
      });
    }
    return {
      glyphs: (bytes) => Array.from(bytes, (code) => ({
        text: cmap?.map.get(codeKey(1, code)) ?? table[code] ?? "",
        width: singleWidths.get(code) || fallbackWidth,
        space: code === 32,
      })),
    };
  }
}

const FALLBACK_FONT: Font = {
  glyphs: (bytes) => Array.from(bytes, (code) => ({
    text: code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : "",
    width: 500,
    space: code === 32,
  })),
};

const codeLength = (codespace: Array<[number, number, number]>, bytes: Uint8Array, at: number, fallback: number): number => {
  for (let length = 1; length <= 4; length++) {
    if (at + length > bytes.length) break;
    const code = codeOf(bytes, at, length);
    if (codespace.some(([size, low, high]) => size === length && code >= low && code <= high)) return length;
  }
  return Math.min(fallback, bytes.length - at);
};

const cidWidths = (doc: PdfDocument, descendant: PdfDict | undefined): Map<number, number> & { fallback: number } => {
  const widths = new Map<number, number>() as Map<number, number> & { fallback: number };
  const dw = doc.get(descendant, "DW");
  widths.fallback = typeof dw === "number" ? dw : 1000;
  const w = doc.get(descendant, "W");
  if (!Array.isArray(w)) return widths;
  for (let i = 0; i < w.length && widths.size < MAX_CMAP_ENTRIES;) {
    const first = doc.resolve(w[i]);
    const next = doc.resolve(w[i + 1]);
    if (typeof first !== "number") break;
    if (Array.isArray(next)) {
      next.forEach((width, index) => {
        const value = doc.resolve(width);
        if (typeof value === "number") widths.set(first + index, value);
      });
      i += 2;
      continue;
    }
    const width = doc.resolve(w[i + 2]);
    if (typeof next !== "number" || typeof width !== "number") break;
    for (let cid = first; cid <= Math.min(next, first + 0xffff); cid++) widths.set(cid, width);
    i += 3;
  }
  return widths;
};

// ------------------------------------------------------------- interpreter

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

interface TextState {
  font: Font;
  size: number;
  charSpacing: number;
  wordSpacing: number;
  scale: number;
  leading: number;
}

class PageText {
  readonly out: string[] = [];
  chars = 0;
  private penX = 0;
  private penY = 0;
  private placed = false;
  readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }

  private last(): string {
    const last = this.out[this.out.length - 1];
    return last ? last[last.length - 1]! : "\n";
  }

  push(text: string): void {
    if (!text || this.chars >= this.limit) return;
    this.out.push(text);
    this.chars += text.length;
  }

  space(): void {
    const last = this.last();
    if (last !== " " && last !== "\n") this.push(" ");
  }

  /** The text cursor jumped; infer a line break or word gap from the geometry. */
  moveTo(x: number, y: number, size: number): void {
    if (!this.placed) { this.placed = true; this.penX = x; this.penY = y; return; }
    const height = Math.max(Math.abs(size), 0.5);
    if (Math.abs(y - this.penY) > height * 0.5) {
      if (this.last() !== "\n") this.push("\n");
    } else if (x - this.penX > height * 0.15 || this.penX - x > height) {
      this.space();
    }
    this.penX = x;
    this.penY = y;
  }

  advance(x: number, y: number): void {
    this.penX = x;
    this.penY = y;
  }

  breakBlock(): void {
    if (this.last() !== "\n") this.push("\n");
    this.placed = false;
  }
}

const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];

class Interpreter {
  private readonly doc: PdfDocument;
  private readonly fonts: FontCache;
  private readonly visitedForms = new Set<PdfDict>();
  constructor(doc: PdfDocument, fonts: FontCache) {
    this.doc = doc;
    this.fonts = fonts;
  }

  run(content: Uint8Array, resources: PdfDict | undefined, page: PageText, depth = 0): void {
    if (depth > 8) return;
    const doc = this.doc;
    const fontDict = doc.dict(resources?.entries.get("Font"));
    const xobjects = doc.dict(resources?.entries.get("XObject"));
    const lexer = new Lexer(content);
    const operands: PdfValue[] = [];
    const stack: TextState[] = [];
    let state: TextState = { font: FALLBACK_FONT, size: 0, charSpacing: 0, wordSpacing: 0, scale: 1, leading: 0 };
    let ctm: Matrix = [...IDENTITY];
    const ctmStack: Matrix[] = [];
    let tm: Matrix = [...IDENTITY];
    let tlm: Matrix = [...IDENTITY];
    const effectiveSize = (): number => {
      const m = multiply(tm, ctm);
      return state.size * Math.hypot(m[2], m[3]);
    };
    const place = (): void => {
      const m = multiply(tm, ctm);
      page.moveTo(m[4], m[5], effectiveSize());
    };
    const nextLine = (tx: number, ty: number): void => {
      tlm = multiply([1, 0, 0, 1, tx, ty], tlm);
      tm = [...tlm];
      place();
    };
    const show = (bytes: Uint8Array): void => {
      for (const glyph of state.font.glyphs(bytes)) {
        page.push(glyph.text);
        const advance = (glyph.width / 1000 * state.size + state.charSpacing + (glyph.space ? state.wordSpacing : 0)) * state.scale;
        tm = multiply([1, 0, 0, 1, advance, 0], tm);
      }
      const m = multiply(tm, ctm);
      page.advance(m[4], m[5]);
    };
    for (;;) {
      if (page.chars >= page.limit) return;
      const token = lexer.next();
      if (token.type === "eof") return;
      if (token.type !== "keyword") {
        const value = parseValue(lexer, false, 0, token);
        if (value !== undefined && operands.length < 64) operands.push(value);
        continue;
      }
      const op = token.word;
      const num = (index: number): number => {
        const value = operands[index];
        return typeof value === "number" && Number.isFinite(value) ? value : 0;
      };
      switch (op) {
        case "BI": {
          // Inline image: skip its binary payload up to a delimited EI.
          const id = content.indexOf(0x49, lexer.pos);
          let at = id;
          while (at >= 0 && !(content[at + 1] === 0x44 && (at === 0 || isWhite(content[at - 1]!)))) at = content.indexOf(0x49, at + 1);
          let end = at < 0 ? content.length : at + 2;
          for (;;) {
            end = content.indexOf(0x45, end);
            if (end < 0) { lexer.pos = content.length; break; }
            if (content[end + 1] === 0x49 && isWhite(content[end - 1] ?? 32) && (end + 2 >= content.length || !isRegular(content[end + 2]!))) {
              lexer.pos = end + 2;
              break;
            }
            end++;
          }
          break;
        }
        case "q": if (stack.length < 64) { stack.push({ ...state }); ctmStack.push([...ctm]); } break;
        case "Q": state = stack.pop() ?? state; ctm = ctmStack.pop() ?? ctm; break;
        case "cm": ctm = multiply([num(0), num(1), num(2), num(3), num(4), num(5)], ctm); break;
        case "BT": tm = [...IDENTITY]; tlm = [...IDENTITY]; break;
        case "ET": break;
        case "Tf": {
          const name = operands[0];
          state = { ...state, font: this.fonts.font(isName(name) ? doc.dict(fontDict?.entries.get(name.name)) : undefined), size: num(1) };
          break;
        }
        case "Tc": state = { ...state, charSpacing: num(0) }; break;
        case "Tw": state = { ...state, wordSpacing: num(0) }; break;
        case "Tz": state = { ...state, scale: num(0) / 100 }; break;
        case "TL": state = { ...state, leading: num(0) }; break;
        case "Td": nextLine(num(0), num(1)); break;
        case "TD": state = { ...state, leading: -num(1) }; nextLine(num(0), num(1)); break;
        case "T*": nextLine(0, -state.leading); break;
        case "Tm":
          tlm = [num(0), num(1), num(2), num(3), num(4), num(5)];
          tm = [...tlm];
          place();
          break;
        case "Tj": if (isString(operands[0])) show(operands[0].bytes); break;
        case "'": nextLine(0, -state.leading); if (isString(operands[0])) show(operands[0].bytes); break;
        case "\"":
          state = { ...state, wordSpacing: num(0), charSpacing: num(1) };
          nextLine(0, -state.leading);
          if (isString(operands[2])) show(operands[2].bytes);
          break;
        case "TJ": {
          const items = operands[0];
          if (!Array.isArray(items)) break;
          for (const item of items) {
            if (isString(item)) { show(item.bytes); continue; }
            if (typeof item !== "number") continue;
            // A large negative adjustment is how many generators draw a word gap.
            if (item < -200) page.space();
            tm = multiply([1, 0, 0, 1, -item / 1000 * state.size * state.scale, 0], tm);
          }
          const m = multiply(tm, ctm);
          page.advance(m[4], m[5]);
          break;
        }
        case "Do": {
          const name = operands[0];
          if (!isName(name)) break;
          const ref = xobjects?.entries.get(name.name);
          const object = doc.objectOf(ref);
          const form = doc.dict(ref);
          if (!form || !isName(doc.get(form, "Subtype"), "Form") || this.visitedForms.has(form)) break;
          this.visitedForms.add(form);
          const data = doc.streamData(object);
          if (data) {
            page.breakBlock();
            this.run(data, doc.dict(form.entries.get("Resources")) ?? resources, page, depth + 1);
          }
          this.visitedForms.delete(form);
          break;
        }
        default: break;
      }
      operands.length = 0;
    }
  }
}

// -------------------------------------------------------------------- entry

const cleanPage = (raw: string): string => raw
  .replace(/[ﬀ-ﬆ]/g, (ligature) => ligature.normalize("NFKC"))
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f�]/g, "")
  .replace(/ /g, " ")
  .split("\n")
  .map((line) => line.replace(/[ \t]+/g, " ").trim())
  .join("\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const hasPdfHeader = (bytes: Uint8Array): boolean => {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 1024)).toString("latin1");
  return head.includes("%PDF-");
};

/**
 * Extract the text layer of a PDF, one string per page. `maxChars` bounds the
 * work: extraction stops once that much text has been collected.
 */
export function extractPdfText(bytes: Uint8Array, options: { maxChars?: number } = {}): PdfTextResult {
  if (bytes.length > PDF_TEXT_MAX_INPUT_BYTES) return { ok: false, reason: "too-large" };
  if (!hasPdfHeader(bytes)) return { ok: false, reason: "malformed" };
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  try {
    const doc = new PdfDocument(bytes);
    doc.scan();
    if (doc.objects.size === 0) return { ok: false, reason: "malformed" };
    if (doc.encrypted()) return { ok: false, reason: "encrypted" };
    const pages = doc.pages();
    if (!pages.length) return { ok: false, reason: "malformed" };
    const interpreter = new Interpreter(doc, new FontCache(doc));
    const texts: string[] = [];
    let total = 0;
    let truncated = false;
    for (const { page, resources } of pages) {
      if (total >= maxChars) { truncated = true; break; }
      const content = doc.contents(page);
      const text = new PageText(maxChars - total);
      if (content) interpreter.run(content, resources, text);
      if (text.chars >= text.limit) truncated = true;
      const cleaned = cleanPage(text.out.join(""));
      texts.push(cleaned);
      total += cleaned.length;
    }
    if (!texts.some((text) => /\S/.test(text))) return { ok: false, reason: "no-text" };
    return { ok: true, pages: texts, pageCount: pages.length, truncated };
  } catch (error) {
    if (error instanceof PdfLimitError) return { ok: false, reason: "too-large" };
    return { ok: false, reason: "malformed" };
  }
}
