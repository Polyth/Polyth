import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AttachmentRef, CanonicalTurnRequest } from "@polyth/contracts";
import { prepareCommandCodeTurnInput } from "../src/turnInput.ts";

const workspace = (): string => {
  const root = mkdtempSync(join(tmpdir(), "polyth-commandcode-range-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "slice.ts"), "one\ntwo\nthree\n");
  return root;
};

const turn = (attachment: AttachmentRef): CanonicalTurnRequest => ({
  sessionId: "canonical",
  text: "Read this range",
  attachments: [attachment],
});

const rangeAttachment = (range?: [number, number]): AttachmentRef => ({
  id: "range",
  name: "slice.ts",
  mime: "text/typescript",
  size: 20,
  kind: "range",
  path: "src/slice.ts",
  ...(range ? { range } : {}),
});

test("Command Code rejects missing, non-finite, reversed and zero-based attachment ranges", () => {
  const cwd = workspace();
  const invalid: AttachmentRef[] = [
    rangeAttachment(),
    rangeAttachment([Number.NaN, 3]),
    rangeAttachment([1, Number.POSITIVE_INFINITY]),
    rangeAttachment([3, 2]),
    rangeAttachment([0, 2]),
    rangeAttachment([1.5, 2]),
  ];

  for (const attachment of invalid) {
    const prepared = prepareCommandCodeTurnInput(cwd, turn(attachment));
    assert.deepEqual(prepared, {
      ok: false,
      code: "invalid-attachment",
      message: "slice.ts has an invalid project line range",
    });
  }
});

test("Command Code keeps a valid one-based inclusive range exact", () => {
  const cwd = workspace();
  const prepared = prepareCommandCodeTurnInput(cwd, turn(rangeAttachment([2, 3])));
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.match(prepared.request.text, /offset=2 and limit=2/);
  assert.doesNotMatch(prepared.request.text, /offset=NaN|limit=NaN|Infinity/);
});
