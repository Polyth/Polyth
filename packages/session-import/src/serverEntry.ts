import type { HarnessContext, HarnessRegistry, RouteHandler, SecureSafeService } from "@polyth/contracts";
import { localOnlyRemoteAccess, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { importSnapshot } from "./index.ts";
import { sourceRefs } from "./refs.ts";
import { redactContinuity } from "@polyth/session";
const fail = (code: string, message: string) => Object.assign(new Error(message), { code });
export default function registerPackage(host: ServerPackageHost) {
    const flights = new Map<string, {
        fingerprint: string;
        promise: Promise<unknown>;
    }>();
    const routes: RouteHandler = async (request) => {
        if (!request.path.startsWith("/api/session-import/"))
            return false;
        const scoped = host.forSpace(request.space);
        const registry = host.services.require(serverServiceKey<HarnessRegistry>("harnesses"));
        const input = request.method === "GET" ? Object.fromEntries(request.url.searchParams) : await request.body();
        const project = typeof input.projectId === "string" ? await scoped.projects.get(input.projectId) : undefined;
        if (!project)
            throw fail("not-found", "project not found");
        const refs = await sourceRefs(host.spaceStorage(request.space).path("session-import/ref-key"));
        const context: HarnessContext = { spaceId: request.space.spaceId, space: request.space, projectId: project.id, cwd: project.path, remote: Boolean(project.remote) };
        if (request.path === "/api/session-import/sources" && request.method === "GET") {
            const providers = registry.providers().filter((p) => p.source);
            const sources = await Promise.all(providers.map(async (provider) => {
                try {
                    const items = (await provider.source!.list(context)).slice(0, 100).map((item) => {
                        const title = redactContinuity(item.title).slice(0, 200);
                        const ref = refs.encode({ spaceId: context.spaceId, projectId: project.id, providerId: provider.descriptor.id, nativeRef: item.ref, title, expires: Date.now() + 15 * 60000 });
                        return { ref, title, updatedAt: item.updatedAt };
                    });
                    return { id: provider.descriptor.id, name: provider.descriptor.name, items };
                }
                catch {
                    return { id: provider.descriptor.id, name: provider.descriptor.name, items: [], unavailable: true };
                }
            }));
            request.json(200, sources);
            return true;
        }
        if (request.path === "/api/session-import/snapshot" && request.method === "POST") {
            const ref = refs.decode(input.ref, context.spaceId, project.id, true);
            const provider = registry.providers().find((p) => p.descriptor.id === ref.providerId);
            if (typeof input.requestId !== "string")
                throw fail("invalid-input", "Snapshot request is incomplete");
            // Expired handles and removed providers may finish a completed durable
            // read, but can never authorize another native source read.
            const source = provider?.source && ref.expires >= Date.now() ? provider.source : {
                list: async () => [],
                async *read() { throw fail("not-found", "Source is unavailable; select it again to start a new Snapshot"); },
            };
            const key = JSON.stringify([context.spaceId, project.id, input.requestId]);
            const fingerprint = JSON.stringify([ref.providerId, ref.nativeRef, ref.title]);
            let flight = flights.get(key);
            if (flight && flight.fingerprint !== fingerprint)
                throw fail("conflict", "Snapshot request id was already used");
            if (!flight) {
                const safe = host.services.get(serverServiceKey<SecureSafeService>("secure-safe"));
                const promise = importSnapshot({ store: host.store, project, context, providerId: ref.providerId, source, ref: ref.nativeRef, requestId: input.requestId, title: ref.title, redact: safe?.redact }).then((projection) => { host.broadcast.projection(projection); return projection; });
                flight = { fingerprint, promise };
                flights.set(key, flight);
                void promise.finally(() => { flights.delete(key); }).catch(() => { });
            }
            request.json(200, await flight.promise);
            return true;
        }
        return false;
    };
    return { routes, remoteAccess: localOnlyRemoteAccess(["session-import"]) };
}
