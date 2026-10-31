# Local models for Judgment

Consumers use [`@polyth/judgment`](../judgment/README.md). This package registers
engine `local` with one keyless provider `local` ("This server"). Evidence never
leaves the Polyth server. Choose it in Settings → Judgment → Engine.

## Models

Models use the [TinyDecide](https://huggingface.co/TheREZOR/TinyDecide) format
(`meta.json` + `model.bin`, a 4-bit ELECTRA-small encoder, Apache-2.0). It answers
`noul`, `choice` (2–32 options) and `score` questions in English; its `span` type is
not part of the Judgment contract.

| Model ID | Source |
| --- | --- |
| `tinydecide` (automatic) | Preset, 6 MB |
| `tinydecide-full` | Preset, 10 MB, larger vocabulary |
| `<name>` | `<space storage>/judgment-local/models/<name>/{meta.json,model.bin}` |

Presets and the engine module (`tinydecide.js`) are downloaded once, on first use,
from a pinned Hugging Face revision; every file's SHA-256 is pinned in
`src/serverEntry.ts` and re-verified on every load, so a wrong file is never run or
kept. The download has its own 120 s deadline; a first Check that times out leaves
it running. User models are listed on each settings read: a folder name matching
`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, regular files only (symlinks are refused), 4 MB
meta / 64 MB weights. They run on the same pinned engine; only their weights are
user-supplied, no user code is executed. A preset name wins over a user folder.

## Execution

Each loaded model runs in its own worker thread (`resourceLimits` 512 MB old space)
evaluating the hash-verified engine as an ES module from a `data:` URL, so the
package bundles without a separate worker file. A forward pass is synchronous
(~0.7–1.5 s on the reference ARM host), so it never runs on the server's event loop.
Requests to one model queue on its worker. Abort terminates the worker: requests
queued behind it fail `provider-error` (retryable) and the next request reloads it.
A model that fails to load answers `model-unavailable` and is dropped. Workers are
terminated on package disable; idle workers are not reaped.

## Normalization

- State: a string is sent as is, other JSON as `JSON.stringify`. The model reads
  127 tokens; a truncated state fails `invalid-request` instead of judging cut
  evidence.
- Choice options are the criteria descriptions; answers map back to labels by index.
- Noul confidence is `max(p, 1 - p)`, as for Jev. Choice/score confidence is the
  engine's own `1 - normalized entropy`, not a top-option probability.
- Native score (0 = first level, 1 = last) is scaled to `[0, levels - 1]`.
- Usage reports the token count as input; there is no cost.

## Verification

```sh
node --experimental-strip-types --test packages/judgment-local/test/*.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/judgment-local
```

Tests run a stand-in engine module in a real worker (offline). The real download,
settings Check and judgments with a preset and a user folder were live-verified on
2026-10-10 against revision `5e0481b8`; answer quality is not evaluated here.
