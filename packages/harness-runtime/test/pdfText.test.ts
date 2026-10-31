import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { extractPdfText, PDF_TEXT_MAX_INPUT_BYTES } from "../src/pdfText.ts";
import { buildPdf, linesContent, pagesPdf } from "./pdfFixtures.ts";

const pagesOf = (bytes: Uint8Array): string[] => {
  const result = extractPdfText(bytes);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.ok ? result.pages : [];
};

test("each page's lines come back in order, one string per page", () => {
  const result = extractPdfText(pagesPdf([
    linesContent(["Quarterly report", "Revenue grew 12%"]),
    linesContent(["Appendix (draft)"]),
  ]));
  assert.deepEqual(result, {
    ok: true,
    pages: ["Quarterly report\nRevenue grew 12%", "Appendix (draft)"],
    pageCount: 2,
    truncated: false,
  });
});

test("Flate-compressed content streams are decoded", () => {
  assert.deepEqual(pagesOf(pagesPdf([linesContent(["Compressed text"])], { compress: true })), ["Compressed text"]);
});

test("a wide TJ adjustment reads as a word gap and kerning does not split words", () => {
  const content = "BT /F1 12 Tf 72 720 Td [(Hel) -20 (lo) -400 (world)] TJ ET";
  assert.deepEqual(pagesOf(pagesPdf([content])), ["Hello world"]);
});

test("WinAnsi punctuation and a Differences glyph name map to Unicode", () => {
  const font = "/Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding << /BaseEncoding /WinAnsiEncoding /Differences [65 /afii10017 /afii10103] >>";
  // \223 \224 \226 are WinAnsi “ ” –; codes 65/66 were redefined as А and і.
  const content = "BT /F1 12 Tf 72 720 Td (\\223quoted\\224 \\226 AB) Tj ET";
  assert.deepEqual(pagesOf(pagesPdf([content], { font })), ["“quoted” – Аі"]);
});

test("a Type0 font is decoded through its ToUnicode CMap", () => {
  const cmap = [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "1 begincodespacerange <0000> <FFFF> endcodespacerange",
    "6 beginbfchar <0001> <041F> <0002> <0440> <0003> <0438> <0004> <0432> <0005> <0456> <0006> <0442> endbfchar",
    "1 beginbfrange <0010> <0012> <0430> endbfrange",
    "endcmap CMapName currentdict /CMap defineresource pop end end",
  ].join("\n");
  const bytes = buildPdf([
    { dict: "/Type /Catalog /Pages 2 0 R" },
    { dict: "/Type /Pages /Kids [3 0 R] /Count 1" },
    { dict: "/Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R" },
    { stream: "BT /F1 12 Tf 72 720 Td [<000100020003000400050006> -400 <001000110012>] TJ ET" },
    { dict: "/Type /Font /Subtype /Type0 /BaseFont /Sans /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R" },
    { dict: "/Type /Font /Subtype /CIDFontType2 /BaseFont /Sans /DW 600" },
    { stream: cmap, compress: true },
  ]);
  assert.deepEqual(pagesOf(bytes), ["Привіт абв"]);
});

test("objects inside a compressed object stream and an xref-stream trailer are found", () => {
  const catalog = "<< /Type /Catalog /Pages 11 0 R >>";
  const pages = "<< /Type /Pages /Kids [1 0 R] /Count 1 /Resources << /Font << /F1 3 0 R >> >> >>";
  const header = `10 0 11 ${catalog.length + 1} `;
  const objstm = deflateSync(Buffer.from(`${header}${catalog}\n${pages}`, "latin1"));
  const bytes = buildPdf([
    { dict: "/Type /Page /Parent 11 0 R /Contents 2 0 R" },
    { stream: linesContent(["Modern writer output"]), compress: true },
    { dict: "/Type /Font /Subtype /Type1 /BaseFont /Helvetica" },
    { dict: `/Type /ObjStm /N 2 /First ${header.length} /Filter /FlateDecode`, stream: new Uint8Array(objstm) },
  ], { root: 10, xrefStream: true });
  assert.deepEqual(pagesOf(bytes), ["Modern writer output"]);
});

test("text drawn by a form XObject is part of the page", () => {
  const bytes = buildPdf([
    { dict: "/Type /Catalog /Pages 2 0 R" },
    { dict: "/Type /Pages /Kids [3 0 R] /Count 1" },
    { dict: "/Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Fm1 6 0 R >> >> /Contents 4 0 R" },
    { stream: `${linesContent(["Body"])} q /Fm1 Do Q` },
    { dict: "/Type /Font /Subtype /Type1 /BaseFont /Helvetica" },
    { dict: "/Type /XObject /Subtype /Form /BBox [0 0 612 792]", stream: "BT /F1 9 Tf 72 40 Td (Footer note) Tj ET" },
  ]);
  assert.deepEqual(pagesOf(bytes), ["Body\nFooter note"]);
});

test("a password-protected file is refused, not decrypted", () => {
  const bytes = pagesPdf([linesContent(["secret"])], { trailerExtra: "/Encrypt << /Filter /Standard /V 2 /R 3 >> " });
  assert.deepEqual(extractPdfText(bytes), { ok: false, reason: "encrypted" });
});

test("a page with only an image (a scan) has no text layer", () => {
  const bytes = buildPdf([
    { dict: "/Type /Catalog /Pages 2 0 R" },
    { dict: "/Type /Pages /Kids [3 0 R] /Count 1" },
    { dict: "/Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R" },
    { stream: "q 612 0 0 792 0 0 cm /Im1 Do Q" },
    { dict: "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode", stream: "\xff\xd8\xff" },
  ]);
  assert.deepEqual(extractPdfText(bytes), { ok: false, reason: "no-text" });
});

test("bytes that are not a PDF are malformed", () => {
  assert.deepEqual(extractPdfText(new TextEncoder().encode("hello, not a pdf")), { ok: false, reason: "malformed" });
  assert.deepEqual(extractPdfText(new TextEncoder().encode("%PDF-1.4\nnothing else")), { ok: false, reason: "malformed" });
});

test("input over the size cap is refused before parsing", () => {
  assert.deepEqual(extractPdfText(new Uint8Array(PDF_TEXT_MAX_INPUT_BYTES + 1)), { ok: false, reason: "too-large" });
});

test("extraction stops at maxChars and says it was truncated", () => {
  const long = Array.from({ length: 40 }, (_, index) => `Line number ${index} of a long page`);
  const result = extractPdfText(pagesPdf([linesContent(long), linesContent(["never read"])]), { maxChars: 120 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.truncated, true);
  assert.equal(result.pageCount, 2);
  assert.ok(result.pages.join("").length <= 120);
  assert.doesNotMatch(result.pages.join("\n"), /never read/);
});
