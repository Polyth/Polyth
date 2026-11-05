# Client API

The Client API lets any program be a Polyth client: a bot, an editor plugin, a
desktop or mobile app, a script. It is versioned and bearer-only, separate from
the internal routes Polyth's own UI uses, so those can keep changing.

| What | Where |
|---|---|
| API description | [`docs/api/client-v1.openapi.json`](../api/client-v1.openapi.json) |
| Published shapes and the event mapping | `packages/contracts/src/clientApi.ts` (`@polyth/contracts/client-api`) |
| Routes | `packages/server/src/routes/clientApi.ts`, grants in `CORE_REMOTE_ACCESS` (`remotePolicy.ts`) |
| TypeScript client, no runtime dependencies | `packages/client` (`@polyth/client`) |
| Where people manage apps | Settings → Apps (`apps/web/src/components/settings/AppsPage.tsx`) |

```ts
import { createPolythClient, signIn } from "@polyth/client";

const token = await signIn({
  url: "https://polyth.example",
  name: "Telegram bot",
  access: "control",
  onCode: ({ userCode, verificationUrl }) => show(userCode, verificationUrl),
});
const polyth = createPolythClient({ url: "https://polyth.example", token });
const [project] = await polyth.projects();
const chat = await polyth.sessions.create({ projectId: project.id, title: "From the bot" });
await polyth.sessions.send(chat.id, { text: "Hello" });
for await (const event of polyth.sessions.stream(chat.id)) handle(event);
```

## Connecting an app

An app is a person's access token with `kind: "app"`
(`packages/identity/src/accessTokens.ts`). There are two ways to get one:

- **With a code.** The app calls `POST /api/auth/cli/device` with `{ kind: "app",
  label, profile }`, shows the code, and polls `POST /api/auth/cli/device/token`.
  The person confirms on Settings → Apps; the link in `verificationPath` plus
  `&code=` opens the page with the code filled in. The token comes back once and
  expires after a year. These two endpoints refuse a request carrying `Origin`
  or `Sec-Fetch-Site`, so a web page cannot drive them. An app must name itself,
  and the person is told that the name is the app's own.
- **Created in Settings → Apps**, for an app that cannot show a code. The person
  chooses the expiry and may pin it to one Space.

| Profile | Grants |
|---|---|
| `read` | Projects, sessions, notifications, health |
| `control` | `read`, plus starting sessions, sending messages, answering questions, stopping turns, refusing requests |
| `approve` | `control`, plus approving agents' permission requests |

## Approving agent actions

Only the instance owner can give an app `core.requests.respond`, one app at a
time, and it is off unless they turn it on:

- A sign-in that asks for `approve` shows a switch, off by default. Confirming
  the code without it connects the app with `control`. A person who is not the
  owner cannot turn it on, and the app connects without it.
- `POST /api/auth/cli/tokens` with `profile: "approve"` is refused for anyone but
  the owner.
- The grant is read against the owner role on every request, so it ends when the
  role does. Granting it (`app.owner-grant-allowed`) and each approval
  (`app.permission-approved`) are in the audit log.
- Approving is always for one action, once. A standing "always allow",
  delegating a request, turning on Auto-Approve or Full access, and credential
  requests all stay in Polyth's UI.

**Accepted risk.** Agents run as the server's OS user. A process that can read
such a token can use it, so an agent on the same machine could approve its own
request if the app keeps its token there. That is why the switch states the
consequence, and why terminal and automation tokens still cannot hold this grant
(`CLI_TOKEN_GRANTABLE`). A guarded account's ceiling applies as everywhere.

## Boundaries

- `/api/v1` takes bearer tokens only. A browser session, a paired device and the
  control socket are refused, so there is no cookie for a foreign page to ride.
  A terminal or automation token may use it with its own grants.
- An app's token reaches `/api/v1` and nothing else: no UI route, no package
  route, no WebSocket, no static file. It can withdraw itself with
  `POST /api/auth/cli/logout`.
- Tokens travel only over TLS or on loopback. `@polyth/client` refuses a plain
  `http://` address on another machine before sending anything.
- The facade reads a short allowlist of request fields and publishes an allowlist
  of event types and fields. A hidden prompt, command, memory setting, worktree
  path or permission level cannot be sent, and recovery prompts, memory, runtime
  receipts, reasoning and credential requests never leave
  (`clientEventFromSessionEvent`).
- Space isolation comes from the same scoped services as the UI: a session in
  another Space answers exactly like a missing one.
- What an app sends is stamped from its token as `author.via: "app"` and
  `author.viaName` (never from the request), and chat shows "Sent from <name>".

## Following a chat

`GET /api/v1/sessions/:id/events` answers one page, or holds the read with
`waitMs`, or streams with `Accept: text/event-stream`. Every stream frame is
re-read from persisted history (`sessionEventWaiters.ts` wake-ups are only
hints), so a missed wake costs latency, never an event, and `Last-Event-ID`
resumes exactly. A stream re-checks its token on every wake and at least every
15 s, then says `event: end` with a `reason` and closes. One token holds at most
16 streams.

A client ignores event types and fields it does not know. Within v1 changes are
additive. Assistant text arrives as `message.delta` while it is written, then
whole as `message.assistant`.

## Retries

A failed connection does not say whether a message arrived. Retry only with the
same `clientOperationId` (a UUID, folded with the account), which can never
deliver a message twice or create a second chat; `@polyth/client` generates one
and reports it on the error. A replayed send answers without `turnId`.

## Not in v1 yet

Web pages cannot sign in or call the API (no OAuth, no CORS). No attachments,
because `/api/files/upload` needs `filesWrite`, which tokens cannot hold. An app
sees every chat its account sees in the Space or Spaces it reaches. There are no
per-app limits on turns, so an app can spend what its account can. Terminal and
voice need a WebSocket. An app reaches Polyth only over HTTPS or loopback, not
through Polyth Link. `@polyth/client` is not published to a registry.

## Verification

- `node --experimental-strip-types --test packages/server/test/clientApi.test.ts packages/client/test/client.test.ts packages/identity/test/accessTokens.test.ts packages/control-plane/test/migration.test.ts`
- `packages/server/test/clientApi.test.ts` also checks that the OpenAPI file and
  the route table list the same routes.
- `scripts/agent-beta.ts` makes loopback the owner already, which hides token and
  sign-in checks. Verify those on a plain server: initialize a canonical install
  with `createCanonicalSecurity(...).identity.setup.*`, then run
  `packages/server/src/index.ts` with `HOST`, `PORT` and `POLYTH_DATA_DIR`. To
  raise a real permission request without a paid turn, point
  `PI_CODING_AGENT_DIR` at a `models.json` naming a local OpenAI-compatible
  server that answers with a call to a permission-gated tool such as
  `shared_chat`.
