# Notifications, permissions, question cards, and voice

## Current Polyth baseline

Canonical `permission/requested|resolved` and `question/asked|answered` events already replay into `PermissionBanner` and `QuestionCards`; REST supports once/always/reject and answer/reject. `notify.ts` already sends hidden-tab completion notifications and optional sound from `polyth.settings`. `packages/dictation`/`voice.tsx` already provide browser Web Speech dictation, local speech synthesis, a typed composer slot, and `polyth.voice`. Extend these; do not bypass the event log.

## 1. Notification templates, filtering, and summaries

**Sources:** polyth #123, #317, #2156.

**Acceptance criteria**

- Users independently enable completion, failure, question, permission, and delegated-agent notifications.
- Notifications include project/session title and a safe bounded preview. Clicking activates the owning project/session.
- Foreground active-session events do not create noisy native notifications by default.
- Delegated-agent completion and session errors are attributed to the correct parent.
- Optional model summaries are off by default and fail back to deterministic templates.

Extend `UiSettings`:

```ts
interface NotificationPrefs {
  enabled: boolean;
  sound: boolean;
  kinds: Array<"completed"|"failed"|"question"|"permission"|"subagent">;
  onlyWhenHidden: boolean;
  template: string;
  summarize: boolean;
}
```

Store under `polyth.settings.notifications`, migrating existing booleans. Template variables are allowlisted (`{project}`, `{session}`, `{status}`, `{preview}`), escaped, and capped.

If summarization is enabled, `packages/backend-opencode` alone generates it; append `notification/summary {sourceSeqs,text}` before native/UI display. Deterministic notifications derive from already logged events and need no new event. Never include tool secrets, permission metadata values, full file contents, or reasoning in a system notification.

Components: `NotificationSettings`, `NotificationRouter`; classes `.notification-preview`, `.notification-kind-list`.

**Tests:** permission denied, hidden/foreground, parent/subagent mapping, duplicate replay, template unknown variable, secret redaction, summary failure, click after session archived.

## 2. Permission preview and toast actions

**Sources:** polyth #559; Paseo #1168, #1980.

Permission UI shows session/project, tool/action, normalized target patterns, and distinct mode icons. Actions remain Allow once, Allow always, Reject. “Always” scope is explicit (`session`, `project`, or exact origin/action family) and never silently global.

Extend payload compatibly:

```ts
interface PermissionRequestData {
  requestId: string;
  permission: string;
  patterns: string[];
  metadata?: JsonObject;
  tool?: string;
  preview?: { title: string; lines: string[]; risk?: "low"|"medium"|"high" };
  allowedScopes?: Array<"once"|"session"|"project">;
}
```

REST reply becomes:

```http
POST /api/sessions/:id/permission/:requestId
{"reply":"once|always|reject","scope":"session|project"}
```

Keep old clients valid by defaulting `always` to the existing safe scope. Preview generation occurs server-side with secret redaction before the request event is appended. Desktop-only native toasts are not implemented; browser in-app toasts and native Notification clicks route to the banner.

Classes: `.permission-toast`, `.permission-preview`, `.permission-risk`, `.permission-mode-icon`.

**Tests:** request ownership, unavailable scope, duplicate response, stale request, redaction, focus/keyboard actions, reconnect.

## 3. Multi-question stepper

**Sources:** Paseo #1310, #1462, #1643.

Normalize question schema in `@polyth/contracts`:

```ts
interface QuestionItem {
  id: string;
  title?: string;
  prompt: string;
  type: "single"|"multi"|"text";
  options?: Array<{ value: string; label: string; description?: string }>;
  required?: boolean;
  allowOther?: boolean;
}
interface QuestionRequestData { requestId: string; questions: QuestionItem[] }
```

One question is visible at a time with numbered tabs, Back/Next, and Submit only on the final valid step. Single choice uses radios; multi choice uses checkboxes; text uses the IME-safe input primitive. Preserve entered answers while navigating. Validation is client-friendly but server authoritative.

Submit existing endpoint with `{answers: Record<questionId,string|string[]>}`; the session service appends `question/answered` before cards disappear. Reject remains explicit.

Components/classes: `QuestionStepper`, `QuestionNav`, `QuestionField`, `.question-stepper`, `.question-tabs`, `.question-option`, `.question-progress`.

**Tests:** required/optional, Other text, duplicate option values, step navigation, IME, Enter behavior, reconnect with draft answers, server schema rejection.

## 4. Copy question as Markdown/JSON

**Source:** polyth #1305.

Question menu provides:

- Copy as Markdown: heading, prompt, options with selected markers, and current answers.
- Copy as JSON: stable `{requestId,questions,answers}` shape.

Implement pure `questionSerializers.ts`; never include hidden permission/session metadata or internal event envelope fields. Copy feedback uses an accessible live region. No API/event.

Test quotes/newlines, no answer, multi-select, Other, Unicode, clipboard denial, and deterministic key order.

## 5. Sending dismisses pending requests

**Sources:** polyth #1740, #2445.

The atomic send-time design is in `10-chat-composer.md`. Required ordering is:

1. Resolve/reject open questions and permissions for the target session.
2. Append their resolution events.
3. Admit/queue the new user message.
4. Return one response.

No client loop over request IDs. Requests belonging to another session remain open. Test concurrent manual answer, failed send, queue mode, and replay.

## 6. Server-authoritative streaming dictation

**Sources:** polyth #2018; Paseo #3159, #2745.

Browser Web Speech remains the zero-configuration fallback. Add an optional streaming path for consistent STT and reconnect:

```ts
interface DictationSession {
  id: string; sessionId?: string;
  status: "starting"|"recording"|"finalizing"|"done"|"failed";
  format: { encoding: "pcm_s16le"; sampleRate: 16000; channels: 1 };
  acknowledgedSeq: number;
}
```

```http
POST   /api/dictation {"sessionId":"...","language":"en-US"}
POST   /api/dictation/:id/finalize
DELETE /api/dictation/:id
GET    /api/dictation/:id
```

Use the existing `/ws` connection:

```json
{"type":"dictation/start","dictationId":"..."}
{"type":"dictation/audio","dictationId":"...","seq":12,"pcm":"base64..."}
{"type":"dictation/ack","dictationId":"...","seq":12}
{"type":"dictation/transcript","dictationId":"...","revision":4,"text":"...","final":false}
```

Prefer binary WS audio frames when the gateway supports typed binary envelopes. The browser keeps bounded PCM segments until acknowledged and replays from the last ack after reconnect. Server deduplicates `(dictationId,seq)`, caps duration/bytes/gaps, and finalizes once.

`packages/dictation` owns audio session/buffering/provider-neutral STT contracts. An STT adapter may call its own configured speech service; it must not talk to OpenCode. If a model is used for cleanup, only `packages/backend-opencode` may do so.

Interim transcript is transient composer state and not a session event. Before auto-send, publish the final text into the composer, append normal `user/message` through the send path, then submit; the visible prompt never disappears early. If final transcript is inserted but not sent, it persists as the session draft.

Settings under server/user config: engine, language, auto-send, max duration; browser `polyth.voice` retains UI/TTS preferences. Components: `ComposerDictation`, `DictationMeter`, `DictationRecovery`; classes `.dictation-recording`, `.dictation-meter`, `.dictation-reconnecting`.

**Security/tests**

- Explicit microphone permission and recording indicator; Stop always available.
- No raw audio in logs/session events. Temporary audio deleted after finalization/timeout.
- Test duplicate/out-of-order chunks, disconnect/replay, ack loss, finalization race, max duration, device loss, tab reload, transcript-before-send ordering, fallback Web Speech.

## Suggested implementation order

1. Typed question schema/stepper/serializers.
2. Permission preview/scopes and pending badges.
3. Atomic send-time dismissal.
4. Notification routing/templates/subagent attribution.
5. Dictation WS protocol/buffering.
6. STT adapter, reconnect UI, and final transcript send ordering.

## Global implementation contract

- Node 22 erasable TypeScript; explicit `.ts` local imports; no enums/namespaces/parameter properties.
- Use workspace package imports.
- Only `packages/backend-opencode` invokes OpenCode/model cleanup or summaries.
- Append generated summaries, final prompt text, requests, and resolutions before display/model use.
- Extend `/api` and `/ws`.
- UI integrates through typed composer/settings/session badge slots.
- Tests use `node --test` and plain `node:assert`.
