import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOwnedLocalEndpointLease } from "../src/endpoint.ts";

test("owned local OpenCode uses the real Polyth Linux supervisor", { skip: process.platform !== "linux" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-opencode-supervisor-"));
  const binary = join(directory, "fake-opencode.mjs");
  const pidFile = join(directory, "opencode.pid.json");
  await writeFile(binary, `#!${process.execPath}\nimport {writeFileSync} from "node:fs";import {createServer} from "node:http";writeFileSync(process.env.OPENCODE_DB,"test database");const args=process.argv.slice(2);const port=Number(args[args.indexOf("--port")+1]);const host=args[args.indexOf("--hostname")+1];const expected="Basic "+Buffer.from("opencode:"+process.env.OPENCODE_SERVER_PASSWORD).toString("base64");const server=createServer((request,response)=>{if(request.headers.authorization!==expected){response.writeHead(401).end();return}response.setHeader("content-type","application/json");response.end(JSON.stringify({healthy:true,version:"1.18.30"}))});server.listen(port,host,()=>{const address=server.address();process.stdout.write("opencode server listening on http://"+host+":"+address.port+"\\n")});`);
  await chmod(binary, 0o700);
  let lease: Awaited<ReturnType<typeof createOwnedLocalEndpointLease>> | undefined;
  try {
    lease = await createOwnedLocalEndpointLease({
      projectId: "project-supervisor",
      cwd: directory,
      runtimeDir: join(directory, "runtime"),
      pidFile,
      stateFile: join(directory, "runtime.lease.json"),
      resolveBinary: async () => ({ executablePath: binary, binarySource: "configured" }),
      inspectEngine: async () => ({
        engine: "opencode",
        version: "test",
        binaryDigest: "a".repeat(64),
        protocolGeneration: 1,
      }),
      port: 0,
    });
    const endpoint = await lease.endpoint();
    assert.equal(endpoint.control.kind, "owned");
    assert.ok(Number(new URL(endpoint.url).port) > 0, "Polyth allocates port zero before spawning");
    const authorityState = JSON.parse(await readFile(`${pidFile}.supervisor.json`, "utf8")) as {
      pid: number;
      receiptFile: string;
      authorityId: string;
      generation: number;
    };
    assert.match(await readlink(`/proc/${authorityState.pid}/exe`), /polyth-supervisor$/);
    assert.equal(authorityState.authorityId, endpoint.authorityId);
    assert.equal(authorityState.generation, endpoint.generation);
    await lease.dispose();
    lease = undefined;
    assert.deepEqual(JSON.parse(await readFile(authorityState.receiptFile, "utf8")), {
      authorityId: endpoint.authorityId,
      generation: endpoint.generation,
    });
  } finally {
    await lease?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
