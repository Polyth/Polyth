// Synthetic PDFs for the text-layer extractor. Built in code so no binary
// document is committed and each case shows exactly the structure it tests.
import { deflateSync } from "node:zlib";

export interface PdfObjectSpec {
  /** Dictionary body without the `<< >>`, or a whole non-dictionary value. */
  dict?: string;
  value?: string;
  stream?: Uint8Array | string;
  /** Deflate the stream and declare `/Filter /FlateDecode`. */
  compress?: boolean;
}

const latin1Bytes = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);

export interface BuildOptions {
  trailerExtra?: string;
  /** Catalog object number; defaults to 1. */
  root?: number;
  /** End with a cross-reference stream instead of a classic `trailer`, as
   *  PDF 1.5+ writers do. Its table is empty: the extractor never reads it. */
  xrefStream?: boolean;
}

/** Assemble numbered objects (1-based, object 1 is the catalog by default). */
export function buildPdf(objects: readonly PdfObjectSpec[], options: BuildOptions = {}): Uint8Array {
  const root = options.root ?? 1;
  const trailerExtra = options.trailerExtra ?? "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (chunk: Uint8Array | string): void => {
    const bytes = typeof chunk === "string" ? latin1Bytes(chunk) : chunk;
    chunks.push(bytes);
    length += bytes.length;
  };
  push("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(length);
    push(`${index + 1} 0 obj\n`);
    if (object.stream !== undefined) {
      const raw = typeof object.stream === "string" ? latin1Bytes(object.stream) : object.stream;
      const data = object.compress ? new Uint8Array(deflateSync(raw)) : raw;
      const filter = object.compress ? " /Filter /FlateDecode" : "";
      push(`<< ${object.dict ?? ""}${filter} /Length ${data.length} >>\nstream\n`);
      push(data);
      push("\nendstream");
    } else {
      push(object.value ?? `<< ${object.dict ?? ""} >>`);
    }
    push("\nendobj\n");
  });
  const xref = length;
  if (options.xrefStream) {
    const num = objects.length + 1;
    push(`${num} 0 obj\n<< /Type /XRef /Size ${num + 1} /W [1 4 2] /Root ${root} 0 R ${trailerExtra}/Length 0 >>\nstream\n\nendstream\nendobj\n`);
  } else {
    push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
    for (const offset of offsets) push(`${String(offset).padStart(10, "0")} 00000 n \n`);
    push(`trailer\n<< /Size ${objects.length + 1} /Root ${root} 0 R ${trailerExtra}>>\n`);
  }
  push(`startxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Escape a latin-1 string for a PDF literal `( )`. */
export const literal = (text: string): string => `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;

/** One content stream per page, drawn with a WinAnsi Helvetica as `/F1`. */
export function pagesPdf(
  contents: readonly string[],
  options: { compress?: boolean; trailerExtra?: string; font?: string } = {},
): Uint8Array {
  const pageCount = contents.length;
  const firstPage = 4;
  const kids = contents.map((_, index) => `${firstPage + index * 2} 0 R`).join(" ");
  const objects: PdfObjectSpec[] = [
    { dict: "/Type /Catalog /Pages 2 0 R" },
    { dict: `/Type /Pages /Kids [${kids}] /Count ${pageCount} /Resources << /Font << /F1 3 0 R >> >>` },
    { dict: options.font ?? "/Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding" },
  ];
  contents.forEach((content, index) => {
    objects.push({ dict: `/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${firstPage + index * 2 + 1} 0 R` });
    objects.push({ stream: content, ...(options.compress ? { compress: true } : {}) });
  });
  return buildPdf(objects, options.trailerExtra ? { trailerExtra: options.trailerExtra } : {});
}

/** Lines drawn top-down in one text object, 14pt apart. */
export const linesContent = (lines: readonly string[]): string =>
  `BT /F1 12 Tf 72 720 Td ${lines.map((line, index) => `${index ? "0 -14 Td " : ""}${literal(line)} Tj`).join(" ")} ET`;
