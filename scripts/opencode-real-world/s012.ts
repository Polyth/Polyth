/** OC-REAL-012: in-root file, line range, image, HTTPS URL attachments, and a
 * traversal/out-of-root path — request body vs upstream prompt parts, live model. */
import { writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  attachRuntimeLifecycle,
  createBorrowedExternalEndpointLease,
  createOpenCodeRuntimeFacade,
  createOpenCodeRuntimeLifecycle,
} from "@polyth/backend-opencode";
import {
  CHEAP_MODEL,
  makeScratch,
  sleep,
  spawnServe,
  startFaultProxy,
  waitForAssistantCompletion,
  writeEvidence,
  writeVerdict,
  WireLog,
  OPENCODE_VERSION,
} from "./lib.ts";

// 1x1 red PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const main = async (): Promise<void> => {
  const scratch = await makeScratch("OC-REAL-012");
  const wire = new WireLog(join(scratch.logsDir, "wire.ndjson"));
  const failures: string[] = [];
  await writeFile(join(scratch.project, "attach.txt"), "ATTACH-LINE-1\nATTACH-LINE-2 RANGE-MARKER\nATTACH-LINE-3\nATTACH-LINE-4\n");
  await writeFile(join(scratch.project, "pixel.png"), PNG);
  await writeFile(join(scratch.root, "outside-root.txt"), "SECRET-OUTSIDE-ROOT-CONTENT\n");

  const serve = await spawnServe(scratch);
  const proxy = await startFaultProxy(serve.url, wire);
  try {
    const lease = await createBorrowedExternalEndpointLease({
      url: proxy.url,
      location: { directory: scratch.project },
    });
    const lifecycle = await createOpenCodeRuntimeLifecycle({ lease, protocol: "legacy" });
    const facade = attachRuntimeLifecycle(createOpenCodeRuntimeFacade({ lifecycle }), lifecycle);
    const backendId = await facade.ensureSession({
      sessionId: "canonical-attach",
      cwd: scratch.project,
      title: "OC-REAL-012 attachments",
    });
    await sleep(300);

    await facade.startTurn({
      sessionId: "canonical-attach",
      text: "Reply with the exact content of line 2 of the attached text file.",
      model: CHEAP_MODEL,
      attachments: [
        { id: "att-file", name: "attach.txt", mime: "text/plain", size: 60, kind: "file", path: "attach.txt" },
        { id: "att-range", name: "attach.txt#2-3", mime: "text/plain", size: 30, kind: "range", path: "attach.txt", range: [2, 3] },
        { id: "att-img", name: "pixel.png", mime: "image/png", size: PNG.length, kind: "image", path: "pixel.png" },
        { id: "att-url", name: "Example site", mime: "text/html", size: 0, kind: "url", url: "https://example.com/page" },
        { id: "att-evil", name: "outside-root.txt", mime: "text/plain", size: 28, kind: "file", path: "../outside-root.txt" },
      ],
    });
    const done = await waitForAssistantCompletion(serve.url, backendId, scratch.project, 90_000);

    // Request body assertions (what Polyth actually sent upstream).
    const wireLines = (await readFile(wire.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { kind: string; method?: string; path?: string; body?: unknown });
    const promptRequest = wireLines.find((line) => line.kind === "request" && line.method === "POST" && /\/(prompt_async|message)\?/.test(line.path ?? ""));
    const parts = (promptRequest?.body as { parts?: Array<{ type: string; text?: string; url?: string; mime?: string; filename?: string }> })?.parts ?? [];
    const fileParts = parts.filter((part) => part.type === "file");
    const textParts = parts.filter((part) => part.type === "text");
    const fileUrls = fileParts.map((part) => part.url ?? "");

    if (!fileUrls.some((url) => url === `file://${scratch.project}/attach.txt`)) failures.push(`plain file url wrong: ${JSON.stringify(fileUrls)}`);
    if (!fileUrls.some((url) => url === `file://${scratch.project}/attach.txt?start=2&end=3`)) failures.push("range url with start/end missing");
    if (!fileUrls.some((url) => url.endsWith("/pixel.png"))) failures.push("image attachment missing");
    if (!fileParts.some((part) => part.mime === "image/png")) failures.push("image mime lost");
    if (!textParts.some((part) => (part.text ?? "").includes("[Attached link: Example site] https://example.com/page"))) {
      failures.push("url attachment not sent as explicit text");
    }
    if (fileUrls.some((url) => url.includes("outside-root"))) failures.push("TRAVERSAL PATH SENT UPSTREAM");
    const traversalOmitted = !JSON.stringify(parts).includes("outside-root");
    if (!traversalOmitted) failures.push("traversal attachment appeared in body");

    // Upstream message parts (how real OpenCode persisted them).
    const userParts = done.messages
      .filter((message) => (message as { info?: { role?: string } }).info?.role === "user")
      .flatMap((message) => ((message as { parts?: Array<{ type?: string; url?: string; mime?: string; filename?: string; text?: string }> }).parts ?? []));
    const upstreamFileParts = userParts.filter((part) => part.type === "file").map((part) => ({ mime: part.mime, filename: part.filename, url: (part.url ?? "").slice(0, 120) }));

    const assistantText = done.messages
      .filter((message) => (message as { info?: { role?: string } }).info?.role === "assistant")
      .flatMap((message) => ((message as { parts?: Array<{ type?: string; text?: string }> }).parts ?? []))
      .filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
    const modelReadAttachment = assistantText.includes("RANGE-MARKER") || assistantText.includes("ATTACH-LINE-2");
    if (!modelReadAttachment) failures.push(`model could not read attachment content: ${assistantText.slice(0, 120)}`);
    const leakedOutside = assistantText.includes("SECRET-OUTSIDE-ROOT-CONTENT");
    if (leakedOutside) failures.push("out-of-root content leaked to model");

    await writeEvidence(scratch, "attachments.json", {
      sentParts: parts.map((part) => ({ type: part.type, mime: part.mime, filename: part.filename, url: part.url, text: (part.text ?? "").slice(0, 120) })),
      traversalOmitted,
      upstreamFileParts,
      assistantTextSample: assistantText.slice(0, 200),
      modelReadAttachment,
      failures,
    });
    await writeVerdict(scratch, {
      id: "OC-REAL-012",
      verdict: failures.length === 0 ? "pass" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy (forced)",
      observed: `file/range/image sent as file:// parts (range with ?start/end), URL as explicit text part, traversal path omitted from the wire; live model read the attachment content; upstream persisted ${upstreamFileParts.length} file parts`,
      expected: "valid attachments exact and scoped; URL explicit text; traversal rejected pre-I/O",
      attribution: failures.length === 0 ? "NONE" : "POLYTH",
      evidence: [
        "artifacts/opencode-real-world/phase-1-legacy/OC-REAL-012/attachments.json",
        "logs/opencode-real-world/phase-1-legacy/OC-REAL-012/wire.ndjson",
      ],
      notes: "Adapter silently omits out-of-root paths (never sent upstream); the user-facing pre-I/O rejection lives in the server/files layer (deterministic-tested).",
    });
    await facade.dispose();
  } finally {
    await proxy.close();
    await serve.stop();
  }
};

await main();
