import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
type SourceRef = {
    spaceId: string;
    projectId: string;
    providerId: string;
    nativeRef: string;
    title: string;
    expires: number;
};
/** Authenticated opaque picker handles survive restart, but convey no authority
 * outside the independently validated Space and project. No native paths leak. */
export async function sourceRefs(keyFile: string) {
    await mkdir(dirname(keyFile), { recursive: true });
    try {
        await writeFile(keyFile, randomBytes(32), { flag: "wx", mode: 0o600 });
    }
    catch (error) {
        if ((error as {
            code?: string;
        }).code !== "EEXIST")
            throw error;
    }
    const key = await readFile(keyFile);
    return {
        encode(value: SourceRef) {
            const iv = randomBytes(12);
            const cipher = createCipheriv("aes-256-gcm", key, iv);
            const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
            return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
        },
        decode(token: unknown, spaceId: string, projectId: string, allowExpired = false): SourceRef {
            try {
                if (typeof token !== "string" || token.length > 8192)
                    throw new Error();
                const raw = Buffer.from(token, "base64url");
                const cipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
                cipher.setAuthTag(raw.subarray(12, 28));
                const ref = JSON.parse(Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]).toString("utf8")) as SourceRef;
                if (ref.spaceId !== spaceId || ref.projectId !== projectId || (!allowExpired && ref.expires < Date.now()))
                    throw new Error();
                return ref;
            }
            catch {
                throw Object.assign(new Error("source not found"), { code: "not-found" });
            }
        },
    };
}
