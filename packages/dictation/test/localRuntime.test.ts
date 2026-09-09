import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalRuntimeManager } from "../src/localRuntime.ts";

const root = () => mkdtempSync(join(tmpdir(), "polyth-sherpa-runtime-"));

test("local runtime status is explicit and never downloads on read", async () => {
  let fetches = 0;
  const runtime = createLocalRuntimeManager({
    root: root(),
    platform: "linux",
    arch: "x64",
    fetchFn: async () => {
      fetches++;
      throw new Error("must not fetch during status");
    },
  });
  const status = await runtime.status();
  assert.equal(status.state, "missing");
  assert.equal(status.platform, "linux");
  assert.equal(status.arch, "x64");
  assert.equal(fetches, 0);
});

test("unsupported local runtime fails closed without network access", async () => {
  let fetches = 0;
  const runtime = createLocalRuntimeManager({
    root: root(),
    platform: "aix",
    arch: "ppc64",
    fetchFn: async () => {
      fetches++;
      throw new Error("unexpected fetch");
    },
  });
  const status = await runtime.status();
  assert.equal(status.state, "unsupported");
  assert.match(status.error ?? "", /aix\/ppc64/);
  const afterDownload = await runtime.download();
  assert.equal(afterDownload.state, "unsupported");
  assert.equal(fetches, 0);
});

test("concurrent runtime downloads share one upstream flight and remove aborts it", async () => {
  let fetches = 0;
  let aborts = 0;
  const runtime = createLocalRuntimeManager({
    root: root(),
    platform: "linux",
    arch: "x64",
    fetchFn: (_url, init) => {
      fetches++;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          aborts++;
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          aborts++;
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    },
  });

  const first = runtime.download();
  const second = runtime.download();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, 1);
  assert.equal((await runtime.status()).state, "downloading");

  await runtime.remove();
  await Promise.allSettled([first, second]);
  assert.equal(aborts, 1);
  assert.equal((await runtime.status()).state, "missing");
});
