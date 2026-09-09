---
name: polyth-voice
description: Develop dictation, transcription and voice/media flows with measured latency, native permission handling and canonical finalization.
---
# Voice, dictation and media pipelines

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context voice`. This command is a navigation aid, not an audit.

- `packages/dictation`
- `apps/mobile/src/nativeBridge.ts`
- `packages/plugins/src/serverPackage.ts`
- `docs/agents/mobile-matrix.md`
- `docs/agents/security.md`
- `docs/agents/performance.md`

## Workflow and constraints
Define the desired mode: push-to-talk dictation, streaming transcription, voice conversation or TTS playback. Do not conflate an installed speech library with a working end-to-end voice mode. Map microphone permission, capture format, transport, provider/local engine, partial/final transcript, cancellation and insertion into the canonical user turn.

Inspect the current dictation package before adding a second media pipeline. Verify supported codecs, sample rates, language behavior and actual provider API/version from primary sources. Local models must be assessed on available hardware and measured latency; do not claim real-time behavior from marketing or desktop benchmarks on another machine.

Request microphone permission after user intent. Stop and release capture on cancel, navigation, disable and error. Keep interim transcript state separate from committed canonical input, and prevent duplicate final submission. Preserve audio privacy, retention policy, secret handling and explicit fallback choices. Do not silently upload recordings to another provider.

Test denied permission, unplugged device, silence, noisy/long speech, partial network loss, finalization races and mobile foreground recovery. Measure capture-to-first-partial and finalization separately. Read accessibility and keyboard behavior as part of composer integration. A simulated text response is not speech recognition evidence; mark provider, language and device checks that were not run.

## Verification and handoff
Suggested test locations (confirm current files first): Use the owning area and risk matrix; do not invent a test filename.

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
