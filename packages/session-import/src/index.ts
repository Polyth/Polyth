import { createHash } from "node:crypto";
import type { CanonicalEventInput, HarnessContext, Project, SessionPersistence, SessionProjection, SessionSourceProvider } from "@polyth/contracts";
import { redactContinuity } from "@polyth/session";
const fail = (code: string, message: string) => Object.assign(new Error(message), { code });
/** Stable publication identity for one native conversation in one project.
 * Deriving it from source identity (never a title or timestamp) lets a second
 * import of the same native session resolve to the same canonical session
 * instead of duplicating it. */
export function snapshotRequestId(spaceId: string, projectId: string, providerId: string, nativeRef: string): string {
    return "auto-" + createHash("sha256").update(JSON.stringify([spaceId, projectId, providerId, nativeRef])).digest("hex");
}
/** Canonical session id for one Snapshot request. Exported so listing can
 * report already-imported native sessions without reading their history. */
export function snapshotSessionId(spaceId: string, projectId: string, requestId: string): string {
    return "snapshot-" + createHash("sha256").update(JSON.stringify([spaceId, projectId, requestId])).digest("hex");
}
/** Read once, stage bounded transactions without a projection, then publish.
 * Completed publication is idempotent by caller request id. Interrupted reads
 * remain unpublished; they are never resumed against an unverified source tail.
 * A completed read can publish after restart even if the source disappeared. */
export async function importSnapshot(input: {
    store: SessionPersistence;
    project: Project;
    context: HarnessContext;
    providerId: string;
    source: SessionSourceProvider;
    ref: string;
    requestId: string;
    title: string;
    redact?: (text: string) => string;
}): Promise<SessionProjection> {
    const { store, context, project } = input;
    if (!store.appendBatch)
        throw fail("unsupported", "atomic Snapshot publication unavailable");
    if (!context.spaceId || project.spaceId !== context.spaceId || project.id !== context.projectId)
        throw fail("not-found", "project not found");
    if (!/^[A-Za-z0-9-]{16,80}$/.test(input.requestId))
        throw fail("invalid-input", "invalid Snapshot request id");
    const id = snapshotSessionId(context.spaceId, project.id, input.requestId);
    const fingerprint = createHash("sha256").update(JSON.stringify([input.providerId, input.ref, input.title])).digest("hex");
    const existing = await store.projection(id);
    if (existing) {
        const first = (await store.events(id, 0, { beforeSeq: 2 }))[0];
        if (first?.data.fingerprint !== fingerprint || existing.spaceId !== context.spaceId)
            throw fail("conflict", "Snapshot request id was already used");
        return existing;
    }
    let seq = await store.latestSeq(id);
    let title = redactContinuity(input.redact?.(input.title) ?? input.title).slice(0, 200) || "Imported session";
    if (seq > 0) {
        const events = await store.events(id, 0, { limit: 1 });
        if (events[0]?.type !== "session/snapshot-read-completed" || events[0].data.fingerprint !== fingerprint)
            throw fail("conflict", "Previous Snapshot read was interrupted. Start a new Snapshot to read the source again.");
        title = String(events[0].data.title);
    }
    else {
        await store.appendBatch(id, [{ type: "session/snapshot-started", data: { fingerprint, providerId: input.providerId }, ignorable: true }], { expectedSeq: 0 });
        seq++;
        let count = 0;
        let records = 0;
        let totalBytes = 0;
        let batchBytes = 0;
        let batch: Array<CanonicalEventInput & {
            time?: number;
        }> = [];
        const flush = async () => { if (batch.length) {
            await store.appendBatch!(id, batch, { expectedSeq: seq });
            seq += batch.length;
            batch = [];
            batchBytes = 0;
        } };
        for await (const record of input.source.read(context, input.ref)) {
            if ((record.role !== "user" && record.role !== "assistant") || typeof record.text !== "string")
                throw fail("invalid-input", "source returned an invalid dialogue record");
            const text = redactContinuity(input.redact?.(record.text) ?? record.text);
            const size = Buffer.byteLength(text);
            totalBytes += size;
            if (size > 1024 * 1024 || totalBytes > 64 * 1024 * 1024 || ++count > 100000)
                throw fail("import-too-large", "Snapshot exceeds supported dialogue limits");
            if (!text.trim())
                continue;
            records++;
            batchBytes += size;
            batch.push({ type: record.role === "user" ? "user/message" : "assistant/message", data: record.role === "user" ? { text } : { partId: `${input.requestId}-${count}`, text }, time: record.time, producerPlugin: "session-import" });
            if (batch.length >= 200 || batchBytes >= 1024 * 1024)
                await flush();
        }
        await flush();
        if (!records)
            throw fail("invalid-input", "source contains no supported dialogue");
        await store.appendBatch(id, [{ type: "session/snapshot-read-completed", data: { fingerprint, title, records: count }, ignorable: true }], { expectedSeq: seq });
        seq++;
    }
    const now = Date.now();
    const projection: SessionProjection = { id, projectId: project.id, spaceId: context.spaceId, title, status: "idle", harness: { mode: "auto" }, createdAt: now, updatedAt: now };
    await store.appendBatch(id, [{ type: "session/snapshot-imported", data: { providerId: input.providerId, fingerprint, mode: "snapshot" }, ignorable: true }], { projection, expectedSeq: seq, markRead: true });
    return projection;
}
