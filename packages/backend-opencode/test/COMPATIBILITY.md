# OpenCode compatibility

Released contract: [`@opencode/cli@2.0.3`](https://github.com/anomalyco/opencode/tree/v2.0.3).
Legacy CI pin: `opencode-ai@1.18.31`. Desktop bundles the pinned V2 platform
package with npm SHA-512 integrity verification. Installation instructions:
[OpenCode V2](https://opencode.ai/v2/docs).

Auto selection prefers a valid legacy health endpoint over experimental V2
routes in a legacy server. A V2 server selects the V2 adapter. Explicit `legacy`
and `v2` overrides remain deterministic. Decisions belong to a runtime generation.

## Contract coverage

| Surface | Legacy | Released V2 | Main regression tests |
| --- | --- | --- | --- |
| Discovery, isolated DB | `db path` fallback | `debug paths db` | `runtimeStorage`, `remote` |
| Owned startup, restart, disposal | Authenticated health | Authenticated health | `runtimeLifecycle`, `processAuthority`, `runtimeReliabilityMatrix` |
| Protocol selection | Stable legacy wins | Health selects V2 | `protocolContract` |
| Models, providers, agents | Legacy catalog | Available catalog plus integration inventory; activation barrier | `adapter`, `providerV2`, `protocolV2` |
| Sessions, history, pagination | Legacy mapping | Released envelopes and cursors | `protocolV2`, `releasedCompatibility.live` |
| Prompt, queue, steer, interrupt | Existing canonical queue | Admitted turn starts with native `steer`; native queue tested while busy | `runtimeLifecycle`, `protocolV2`, `releasedInference.live` |
| Events and missing-event recovery | Existing event translation | Stream plus independent durable pull | `adapter`, `reconciliation`, `protocolV2`, `releasedInference.live` |
| Permissions | Legacy reply mapping | Session-scoped effects; real MCP permission/reply cycle | `protocolV2`, `releasedInference.live` |
| Interactive input | Questions | Typed forms through shared questions | `v2Forms`, `protocolV2`, `releasedCompatibility.live` |
| MCP, Polyth tools, skills | Private overlays | Native discovery, connection and local-fixture tool execution | `provisioner`, `nativePolythTools`, `nativeCapabilitiesV2.live`, `releasedInference.live` |
| Instructions and context | Canonical prompt projection | Same canonical projection and revision fencing | `capabilityProjection`, `capabilityDelivery` |
| Provider auth | Legacy auth endpoints | Integration key/OAuth methods and credential removal | `providerHttp`, `providerV2`, `releasedCompatibility.live` |
| Configuration | Preserve JSONC and unknown fields | Preserve native fields; ephemeral model-visibility projection | `config`, `configPreservation`, `customProvider` |

Session/form/message corruption is a protocol error. Unsupported optional
reconciliation endpoints (404/405/501) degrade only their corresponding surface;
authentication, malformed responses and transport failures are not swallowed.
Mutation uncertainty never triggers automatic replay.

Polyth tools use the existing authenticated, scoped stdio MCP bridge. This
replaces generated OpenCode plugin code and avoids coupling portable tools to
the native plugin ABI. Discovery and connection receipts do not claim a tool
was invoked. Instruction/context revisions are still admitted through Polyth's
canonical prompt path.

## Run the checks

From the repository root, with the existing workspace dependencies:

```sh
npm run build:supervisor
node --experimental-strip-types --test packages/backend-opencode/test/*.test.ts
OPENCODE_COMPAT_BIN=/absolute/path/to/opencode node --experimental-strip-types --test packages/backend-opencode/test/releasedCompatibility.live.ts
```

Run the following against released V2:

```sh
OPENCODE_COMPAT_BIN=/absolute/path/to/opencode node --experimental-strip-types --test packages/backend-opencode/test/nativeCapabilitiesV2.live.ts
OPENCODE_COMPAT_BIN=/absolute/path/to/opencode node --experimental-strip-types --test packages/backend-opencode/test/releasedInference.live.ts
```

Run legacy native capability discovery against the legacy binary:

```sh
POLYTH_NATIVE_CAPABILITY_TESTS=1 POLYTH_OPENCODE_TEST_BINARY=/absolute/path/to/opencode node --experimental-strip-types --test packages/backend-opencode/test/nativeCapabilities.test.ts
```

The live tests use private HOME/XDG/config/database directories and owned
process cleanup. The inference fixture serves a local OpenAI-compatible API;
it needs no external provider account. The auth smoke stores a dummy key only
in its private runtime, verifies restart persistence, and deletes it. These
checks do not validate a real provider's OAuth website or credential acceptance.

The [CI workflow](../../../.github/workflows/opencode-compatibility.yml) runs
legacy, pinned V2 and non-blocking latest-V2 lanes. npm postinstall must run:
both released packages initially install a guard launcher, then select their
native platform binary during postinstall.

## Boundaries and upstream changes

OAuth methods that fit the existing text/select auth UI are supported. Richer
native auth forms and command-based login are omitted; legacy well-known
credential writes return an explicit unsupported error. Interactive session
forms retain typed reply validation behind the adapter.

Native command execution and exact-history forks use existing runtime
operations. Native command discovery is not advertised without a corresponding
catalog implementation. Remote-host capability projection remains explicitly
unsupported; local runtimes can connect to local or remote MCP servers.

Development sources already differ from 2.0.3 in session input and prompt
contracts. Keep those changes behind this backend and use the latest-V2 canary
to detect released changes; do not copy development SDK shapes into the pinned
adapter. Native platform builds, real SSH hosts, and external OAuth require
separate environment-specific verification.
