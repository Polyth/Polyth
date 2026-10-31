# Custom Titles

Custom Titles owns semantic title generation for untitled sessions. Settings
are stored per Space and exposed through the package's Customize settings page.

- **Fallback after 5 seconds** lets the session harness provide a native title
  first. After that deadline, Custom Titles owns the automatic title.
- **Always use Custom Titles** starts generation after the first turn's
  admission is confirmed and prevents native titles from replacing it.

The request a session is named after is the person's: its first visible message.
A hidden message (a delegated-permission wake) never names a session and never
cancels naming already in progress. A session that receives its request without
a user turn — a workflow parent created by the composer or the Workflows page —
is named from the run's task through `SessionService.requestAutomaticTitle`,
which the workflow package calls once the run is admitted. No harness turn will
title such a session, so both modes generate at once instead of waiting for a
native title; without Custom Titles the session service applies the
prompt-derived title.

The default generator selects an available free text model from the OpenCode
runtime's catalog, preferring the models measured fastest on a title turn and
treating slow reasoning models (Nemotron, "ultra"/"lightning") as a last resort.
Free OpenCode models can only be reached through an OpenCode session turn, so the
title prompt runs as a stateless utility turn: OpenCode skips Polyth's behavior,
delegation and context text and runs it on its hidden tool-less `title` agent
(~3.5k input tokens instead of ~15k on `build`). That agent's own rules ask for
the request's language and ≤50 characters; an explicit language setting
overrides the first. A custom generator uses the selected harness, provider, and
model. Both use the session's worktree directory and the shared small-model
service. The selected generator is acquired directly; naming does not start or
depend on the conversation's harness being available. A deleted project cannot
be redirected to a default runtime. When supported by the runtime pool, the
selected generator uses the canonical session's lease for normal teardown.

## Working with weak models

The generator may be a small, free or agent-tuned model, so nothing depends on it
following the prompt:

- **The request is framed, not forwarded.** The first message (at most 1,500
  characters: its opening and its closing, since the ask often comes last) is
  quoted as data between markers, the rules and a few examples come before it,
  and the last line is the instruction and a `Title:` cue. A model reads what is
  last, and an agent-tuned one otherwise acts on the message instead of naming it.
- **The title is found in the reply.** Reasoning blocks (`<think>…</think>`, also
  unclosed or half-stripped), `<title>`/`<answer>` elements, JSON, code fences,
  markdown, labels (`Title:`, `Назва:`), "Sure! Here is a title:" preambles,
  numbered options, quotes and terminal colour codes are peeled off. A reply with
  no title in it is refused with a reason (`reasoning`, `markup`, `code`,
  `chatter`, `prose`, `echo`, `empty`): tool-call markup such as `<tool_call>`,
  refusals, questions, code, several sentences, or a repeated prompt example. It
  is never clipped into a title; a merely over-long title is cut at a word.
- **One retry.** A reply with no title (or an adapter's empty completion) is asked
  again with a bare few-shot pattern, a shorter input and a larger output cap,
  if the deadline leaves it a budget of at least 8 seconds (what remains, less a
  1.5-second margin so a stalled retry fails before the deadline does). A
  timeout, authentication or model error on the first attempt is not retried and
  is reported as such; a retry that fails after a reply with no title counts as
  one more reply with no title.
- **A last resort for an explicit click.** If the retry also yields nothing,
  **Regenerate title** names the session from the opening words of its first
  message (greetings and "can you please" dropped, at most 8 words) and the menu
  says so instead of presenting it as the model's work. Automatic naming returns
  to the session service's own order: the harness's native title, then the prompt.
- The server log records only the attempt reasons and the generator, never the
  reply. Replies and messages are bounded before any work is done on them.

When enabled, the package adds **Regenerate title** to the desktop and phone
session menus. It uses the first non-empty visible user message (or, for a
workflow parent, the task of its first run); a chat with no sent message yet
uses the caller's own synced composer draft. It applies the current Space's
generator, language, style, and rules, regardless of the automatic naming mode.
The existing title stays intact when generation fails or it changes during generation.
Successful regeneration uses the canonical rename event path and protects the
explicitly requested title from later automatic/native naming, including the
first send after a draft was titled. A session with neither a message nor a
draft is rejected; concurrent regeneration requests are rejected.
Errors before the canonical rename starts report that the title mutation did
not start, with specific messages for a timeout or an unavailable generator or
model. A model that merely answers badly is not an error: see above. An
unconfirmed utility completion does not imply an uncertain user message. If the
canonical rename itself fails, its outcome remains unknown and the menu asks the
user to check the session title before regenerating again. The action never
automatically replays a failed request.

Each generation has a deadline covering runtime resolution, model discovery,
and completion (the retry shares it): 30 seconds for automatic naming, which holds back the session's
fallback title, and 45 seconds for an explicit **Regenerate title**, which
stays under the usual 60-second reverse-proxy read timeout. A title turn on
OpenCode's free models measured 8–36 seconds end to end, so a shorter limit made
the default generator fail routinely. Failure or expiry of automatic naming lets the
canonical session service persist a title derived from the first prompt. Late
setup cannot submit a new completion after expiry; a late result cannot replace
the fallback. Disabling the package cancels its pending generation waits.
Runtime execution and release remain owned by the runtime service. The
response keeps a failed regeneration's cause private; the server logs it.

Focused verification:

```sh
node --experimental-strip-types --test --test-concurrency=1 packages/custom-titles/test/*.test.ts packages/server/test/customTitles.test.ts
```
