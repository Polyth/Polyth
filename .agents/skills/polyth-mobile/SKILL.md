---
name: polyth-mobile
description: Develop Polyth on iOS and Android with shared web UI and Capacitor; distinguish native wiring, builds and device evidence.
---
# Mobile iOS and Android development

## Start here
Repository-relative paths below. Read root `AGENTS.md` once. Locate the current code with `node scripts/agent-kit.mjs context mobile`. This command is a navigation aid, not an audit.

- `apps/mobile/package.json`
- `apps/mobile/src/ConnectionScreen.tsx`
- `apps/mobile/src/runtime.ts`
- `apps/mobile/src/nativeBridge.ts`
- `apps/mobile/src/polythLink.ts`
- `docs/agents/mobile-matrix.md`
- `docs/architecture/polyth-link.md`
- `docs/agents/ui-checklist.md`

## Workflow and constraints
Maintain one shared web product with a Capacitor shell for an existing server. Do not add a phone-side Node runtime, a second authoritative session database or a separate mobile API. Decide whether a change belongs to shared UI, the mobile shell, a native plugin, a server package or the Link transport.

Trace native availability from plugin registration through platform implementation and build inclusion to a real call. `PolythLinkNative` or a setter alone does not prove native pairing exists. The baseline implementation defaults to MissingNativeCore. Read current wiring rather than freezing that limitation forever. LocalNotifications scheduling is not a push-delivery system, and a web dashboard widget is not an OS home-screen widget.

Use the mobile matrix for connection profiles, QR/digital pairing, cancellation, revoked grants, offline/reconnect, foreground/background, streaming gaps, keyboard/safe areas, deep links and server switching. Do not promise a permanent background socket; design resumable foreground recovery and truthful user state. Clear or partition server/account/Space caches; reject stale callbacks after switching or teardown.

Keep secrets and private keys out of JavaScript and logs. Avoid global permission grants, all-host cleartext exceptions or camera prompts before user action. Distinguish cancelled, denied and failed file selection. Test desktop web and both platforms' relevant states. A responsive browser, Capacitor sync, native compilation and real-device functional validation are separate claims; report their evidence separately.

## Verification and handoff
Suggested test locations (confirm current files first): `apps/mobile/test/runtime.test.ts`; `apps/mobile/test/connectionUi.test.ts`

Apply `docs/agents/verification.md` for the actual risk. Report changed paths, behavior verified, exact checks, and unknowns. Source inspection, unit tests, live execution and device evidence are separate. Do not load all other skills or rerun unchanged expensive checks without a causal reason.
