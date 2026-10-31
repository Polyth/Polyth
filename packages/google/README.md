# Google (`@polyth/google`)

Connects Google accounts so agents can use Gmail, Google Calendar and Google
Drive for the person they act for. Accounts belong to a person and are turned
on per Space (Spaces §14.4); a Space admin may also connect shared *service
accounts*. **Sign in with Google** opens one Google consent screen for every
service the OAuth client may ask for; the user can untick any of them there,
and an agent only uses an account that actually granted the service.

Settings → Google is built for people who are not technical: the page shows
one next step at a time (set Google up once → sign in → done), in the
interface language (`src/i18n/<locale>.ts`, one catalog per Polyth locale,
exported as `@polyth/google/i18n` and read through `host.ui.locale.translate`). The OAuth client, Space service accounts and the
service-account policy sit under **Advanced**, closed by default; a settings
search hit on them opens it.

## Architecture

```
src/scopes.ts     capability ↔ OAuth scope map, what each client may request
src/oauth.ts      PKCE, token exchange/refresh/revoke, loopback + pasted-URL sign-in flows
src/accounts.ts   personal and Space service accounts, owner resolution, secrets, token refresh
src/http.ts       the only Google HTTP seam: auth, retries, size limits, error codes
src/gmail.ts      Gmail REST v1 (src/mime.ts parses and composes MIME)
src/calendar.ts   Calendar v3, free/busy and free-slot search
src/drive.ts      Drive v3, Workspace export, multipart/resumable upload, sharing
src/tools.ts      agent tools (contextual capability contributions)
src/routes.ts     /api/google settings and sign-in routes
widgets/          Settings → Google
```

- **Personal accounts** belong to the person who connected them. Any member
  connects their own in Settings → Google → *Your accounts*. Metadata (Google
  account id, email, name, avatar URL, granted scopes, status, the OAuth client
  id that issued it and a per-connection enablement id) is `accounts.json` in
  the person's storage (`host.people.storage(user, "google")`, outside every
  Space); the refresh token is `account:<id>` in the person's own Credential
  Vault partition (`host.people.vault`). Connecting from a Space turns the
  account on there (`host.people.setEnabled`); the person turns it on or off
  per Space. Nobody else, admins included, sees it or can use it. A refresh
  token only works with the client that issued it, so in a Space with a
  different OAuth client the account shows *Reconnect needed*; reconnecting
  there moves it to that client (and away from the old one).
- **Space service accounts** are connected and removed by Space admins
  (*Space service accounts*). Metadata is `packages/google/accounts.json` in
  Space storage and the refresh token is `google:<space>:account:<id>` in the
  Space Credential Vault, which must be enabled. Every account connected before
  person ownership existed is a service account, unchanged (there is no
  migration to a person). Admins see them in full; members see only a label
  (the Google profile name), their status and grants.
- **Agents act for one person.** A tool call takes the session's acting
  person (`ToolExecutionContext.actorUserId`) and picks, with
  `resolveConnectionOwner` from `@polyth/plugins`: that person's accounts turned
  on in this Space → else the Space's service accounts, only when the Space
  policy *Agents may use Space accounts* is on (`host.people.servicePolicy`,
  default **off**) → else it refuses with "Connect your Google account in
  Settings → Google". Turns nobody started (schedules, system work) use only
  service accounts under that policy. An actor who is not a member is refused.
  The `account` argument matches only those candidates, and errors list only
  their emails. Another member's account is never a candidate. Service
  accounts keep the same permission holds (send, share, upload, delete).
- Access tokens live only in server memory, cached per owner
  (`person:<user>:<id>` or `space:<space>:<id>`), so one owner's disconnect or
  refresh never touches another's even for the same Google account.
- **Capabilities** are `gmail.read|send|write`, `calendar.read|write` and
  `drive.file|read|write`. They are derived from the `scope` Google returns, so
  a scope the user unticked on the consent screen is never assumed. A broader
  grant implies the narrower one: `gmail.write` includes `gmail.send`, and
  `drive.write` includes `drive.file`.
- **Agent tools** are registered once and resolved per Space. A Space with an
  OAuth client may offer every Google tool that client can be granted (through
  Polyth's built-in app only calendar, send-only mail and agent-created Drive
  files), one without only what its service accounts granted; a tool needs
  one of its capabilities. When the resolve context names a session's acting
  person (`HarnessContext.actorUserId` with `sessionId`), a tool is offered
  only if an account that person may use here (their enabled ones, else
  service accounts under the Space policy) can serve it — the same resolution
  as the call. A runtime shared across sessions, or a session nobody has written in
  yet, has no acting person and gets the Space-wide set. The call then decides
  again and refuses otherwise. Tool lists are minted when a session's runtime
  starts: running sessions keep that list — including after another person
  becomes the actor mid-chat — and a tool whose account was disconnected, or
  that the new actor cannot use, fails at call time.

| Route | Who | Does |
|---|---|---|
| `GET /api/google` | member | client, own `accounts` (with `enabled` here), `service` (full for admins, labels otherwise), `policy`, `canManage` |
| `PUT`/`DELETE /api/google/client` | admin | Set or remove the Space OAuth client |
| `PUT /api/google/policy` `{agentsMayUseService}` | admin | Let agents use service accounts |
| `POST /api/google/connect` `{capabilities, accountId?, owner?: "person"\|"space"}` | member (`space`: admin) | Start a sign-in for the caller or the Space |
| `GET`/`DELETE /api/google/connect/:state`, `POST …/complete` | the starter | Follow, cancel or finish (pasted URL) that sign-in |
| `PUT /api/google/accounts/:id` `{enabled}` | the owner | Turn their account on or off in this Space |
| `DELETE /api/google/accounts/:id` | the owner | Disconnect their account (revokes at Google) |
| `DELETE /api/google/service-accounts/:id` | admin | Disconnect a service account |

| Tool | Capability | Mutating | Auto-Approve |
|---|---|---|---|
| `google_gmail_read` | gmail.read | no | routine |
| `google_gmail_manage` (drafts, labels, archive, trash) | gmail.write | yes | routine |
| `google_gmail_send` (send; reply, forward and send draft need gmail.write) | gmail.send | yes | **held** |
| `google_calendar_read` (incl. free/busy, free slots) | calendar.read | no | routine |
| `google_calendar_write` (events without guests; nobody notified) | calendar.write | yes | routine |
| `google_calendar_send` (events with guests, guest changes, RSVP) | calendar.write | yes | **held** |
| `google_calendar_delete` | calendar.write | yes | **held** |
| `google_drive_read` (search, read, export, download) | drive.read or drive.file | no | routine |
| `google_drive_write` (folders, rename, trash, move/copy into private folders) | drive.write or drive.file | yes | routine |
| `google_drive_upload` | drive.write or drive.file | yes | **held** |
| `google_drive_share` (permissions, move/copy into shared folders or drives) | drive.write or drive.file | yes | **held** |
| `google_drive_delete` (permanent) | drive.write or drive.file | yes | **held** |

With `drive.file` alone the Drive tools reach only files and folders Polyth
created (Google also counts files a user opens or picks with the app; Polyth
has no file picker yet). With several accounts, a call prefers one with the
full grant over a file-only one unless the agent names an account.

All tools are `credentialed`, so none is auto-allowed as `pure`: in Ask mode
every call asks (and "always allow" works per tool), Full access runs them, and
Auto-Approve answers routine calls but leaves the **held** ones for a person
(the permission risk classifier treats package tools named *send*, *share*,
*upload* or *delete* as high risk; see `docs/agents/security.md`). The approval
card shows a short summary of the call's arguments, such as recipients and
attached files. Routine tools refuse anything that would reach other people —
an event with guests, a move into a shared folder — and point the agent to the
held tool, so Auto-Approve cannot be used to bypass the hold.

Downloads (Gmail attachments, Drive files up to 50 MiB) are written to
`.polyth/downloads/google/` inside the project with a fresh name; that
directory carries its own `.gitignore`. Uploads and attachments read regular
files that resolve inside the project and refuse credential and
repository-internal files (`.env*`, keys, `.git/`, `.ssh/`, `.polyth/` outside
the downloads directory, and similar).

Errors start with a stable code: `not-configured`, `not-connected`,
`account-ambiguous`, `insufficient-scope`, `authorization-revoked`,
`invalid-credentials`, `rate-limited`, `network-error`, `not-found`,
`permission-denied`, `conflict`, `invalid-request`, `too-large`, `cancelled`,
`google-unavailable`, `mutation-outcome-unknown`. Reads retry rate limits and
server errors with backoff; writes are never repeated after an uncertain
outcome (`mutation-outcome-unknown`).

## Sign-in flow

Polyth uses Google's installed-app flow: authorization code + PKCE (S256)
with a loopback redirect `http://127.0.0.1:<ephemeral port>/`. The server
opens a single-use listener bound to 127.0.0.1 for ten minutes, validates
`state`, exchanges the code and closes it. When the browser runs on another
device (phone, remote desktop, container), the redirect cannot reach the
server; the browser shows an unreachable `http://127.0.0.1:…` page and the user
pastes that address into Settings → Google, which completes the same flow
(same `state` and PKCE checks, bound to the Space and user that started it).
The page offers the paste field at once when it is not open on the server's
own machine (its host is not loopback), and behind *Signed in on another
device?* otherwise. Pasting an address that carries `state` and `code` (or
`error`) finishes the sign-in by itself; a **Paste** button reads the
clipboard where the browser allows it. A failed or cancelled sign-in offers
**Try again**, which repeats the same request.

Token-endpoint failures are reported in plain words. Google's
`error_description` is shown with the error code (it never echoes the code or
a token), and a missing client secret (`invalid_request` / "client_secret is
missing.") is reported as `not-configured` with the fix: add the Google app
again from its file.
A personal sign-in completes only while that person is still a member.

**Sign in with Google** asks, in one consent, for the identity scopes
(`openid email profile`) plus every capability the client may request (the
client's `capabilities` in `GET /api/google`); Google lets the user untick
each one. **Allow** on a service row re-runs consent with every scope the
account already has plus the new ones (Google does not support incremental
authorization for installed apps), with `prompt=consent` so a refresh token is
always returned. A reconnect must be completed as the same Google account. A
personal reauthorization keeps the person's per-Space choices; a fresh
connection after a disconnect gets a new enablement id, so other Spaces do not
silently get it back. To reduce access, disconnect (Polyth revokes the grant at
Google) and connect again. Google's grant belongs to the account and OAuth
client, so disconnecting also ends access anywhere else the same Google account
was connected through the same client (another person's or a service
connection of it, other Spaces).

## OAuth clients

The first configured client wins:

1. **The Space's own client** (Settings → Google → Advanced; a Space admin
   adds it). Any capability may be requested.
2. **The server's own client**: `POLYTH_GOOGLE_CLIENT_ID` /
   `POLYTH_GOOGLE_CLIENT_SECRET` in the server environment. Any capability.
3. **Polyth's built-in Google app**: `POLYTH_GOOGLE_BUILTIN_CLIENT_ID` /
   `POLYTH_GOOGLE_BUILTIN_CLIENT_SECRET`, baked into release builds and never
   committed (Google's policy forbids client credentials in public
   repositories and advises against any repository). It may request only
   `calendar.read`, `calendar.write`, `gmail.send` and `drive.file`; the
   connect route refuses anything else, and a reconnect drops scopes an
   earlier client granted beyond that set.

The built-in app keeps to Google's *sensitive* and *non-sensitive* scopes, so
users need no Google Cloud setup and the app needs Google's OAuth review but
not the annual security assessment that *restricted* scopes require. Reading
mail and the whole Drive stay available through an own client.

| Capability | Scopes requested | Google classification | Built-in app |
|---|---|---|---|
| identity | `openid`, `email`, `profile` | non-sensitive | yes |
| gmail.read | `gmail.readonly` | restricted | no |
| gmail.send | `gmail.send` | sensitive | yes |
| gmail.write | `gmail.modify` (read, drafts, send, labels, trash; no permanent delete) | restricted | no |
| calendar.read | `calendar.readonly` | sensitive | yes |
| calendar.write | `calendar.readonly`, `calendar.events` | sensitive | yes |
| drive.file | `drive.file` | non-sensitive | yes |
| drive.read | `drive.readonly` | restricted | no |
| drive.write | `drive` | restricted | no |

### Registering the built-in app (Polyth owner)

Only the owner of the Polyth brand and domain can do this; it is outside the
code.

1. Create a Google Cloud project for Polyth and enable the *Gmail API*,
   *Google Calendar API* and *Google Drive API*.
2. **Google Auth Platform → Branding**: app name *Polyth*, logo, support
   email, home page and privacy policy on the Polyth domain, and the domain
   verified in Search Console. **Audience**: *External*, then publish to
   *In production*.
3. **Data access**: add exactly the built-in scopes from the table above.
4. **Clients → Create client → Desktop app**. Store the ID and secret as the
   release builder's secrets `POLYTH_GOOGLE_BUILTIN_CLIENT_ID` /
   `POLYTH_GOOGLE_BUILTIN_CLIENT_SECRET` (see
   [releases](../../docs/operations/releases.md#external-builder-feed)).
5. Submit for verification: justify each sensitive scope and attach a demo
   video of the consent screen and of agents using Calendar, sending email and
   creating Drive files. The privacy policy must say how Google data is used
   and shared, including that agents send it to the language model the user
   chose. Google's review of sensitive scopes usually takes 3–5 business days.
   Until it passes, users see the "unverified app" warning and the app is
   limited to 100 users.

## Own Google Cloud client

1. In the [Google Cloud console](https://console.cloud.google.com/) create or
   pick a project.
2. **APIs & Services → Library**: enable *Gmail API*, *Google Calendar API*
   and *Google Drive API* (only the ones you will use).
3. **Google Auth Platform → Branding / Audience** (OAuth consent screen):
   app name and support email; user type *External* (or *Internal* for a
   Workspace organization). Add every Google account that will connect as a
   **test user** while the app is in *Testing*.
4. **Data access**: add the scopes from the table above that you will allow.
5. **Clients → Create client → Application type: Desktop app**, then
   download its file (`client_secret_….json`). Desktop clients need no
   redirect URI registration; Google accepts any loopback port.
6. In Polyth, **Settings → Google** (a Space admin is required) and choose
   that file in the last step of *Set up Google once*, or under **Advanced →
   Use your own Google app / Change**. The page reads `installed.client_id`
   and `installed.client_secret` in the browser and refuses a *Web
   application* client's file. Typing the client ID and secret is the
   fallback. The secret is required: Google's token endpoint refuses a Desktop
   client without it, so the server will not save a client without one
   (saving the same client again may keep its stored secret). The secret is
   stored in the Credential Vault. Alternatively set `POLYTH_GOOGLE_CLIENT_ID` /
   `POLYTH_GOOGLE_CLIENT_SECRET` in the server environment as the default for
   every Space; a Space's own client wins.

The setup steps on the page link to the Google Cloud pages for steps 1, 2
(one link enables Gmail, Calendar and Drive), 3 and 5.

With an own client, **Sign in with Google** asks for `gmail.read`, `gmail.write`,
`calendar.read`, `calendar.write`, `drive.read` and `drive.write`.

## Verification and token lifetime

- An app in **Testing** with user type *External* can be used only by its
  test users (up to 100), and Google expires its refresh tokens after **7
  days** for anything beyond the identity scopes; accounts then show
  *Reconnect needed*.
- Moving to **In production** without verification removes the 7-day expiry
  but shows Google's "unverified app" warning and caps the app at 100 users.
  This is the practical setting for a personal or team deployment.
- Publishing an app to the public with **sensitive** scopes requires Google's
  OAuth verification; **restricted** scopes (reading Gmail, the whole Drive)
  additionally require an annual third-party security assessment (CASA). That
  is why the built-in app requests none. Self-hosted deployments that use their
  own project for their own users fall under Google's personal/internal-use
  exemptions; do not share one client across unrelated users.
- Google keeps at most 100 live refresh tokens per account and client; a
  refresh token is also invalidated when the user revokes access, after six
  months unused, or (for Gmail scopes) after a password change. Polyth marks
  such accounts *Reconnect needed* and deletes the dead token.

References: [installed-app OAuth](https://developers.google.com/identity/protocols/oauth2/native-app),
[Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes),
[Calendar scopes](https://developers.google.com/workspace/calendar/api/auth),
[Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
[restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

## Development and tests

No dependency beyond Node built-ins: Google REST APIs are called with `fetch`.

```sh
node --experimental-strip-types --test packages/google/test/*.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/google/tsconfig.json
```

Tests use an in-memory Google (`test/fakeGoogle.ts`) that enforces PKCE, the
redirect URI and, like Google, the Desktop client secret, plus fake `fetch` responses for each API; no Google
credentials are needed; `people()` there is an in-memory `host.people` with the
server's membership and enablement rules. A live smoke test needs a real Desktop client and a
test user: connect in Settings → Google → Your accounts, then start a new agent
session and ask it to, for example, list today's events. To try the built-in
path with such a client, start the server with it as
`POLYTH_GOOGLE_BUILTIN_CLIENT_ID` / `POLYTH_GOOGLE_BUILTIN_CLIENT_SECRET`
instead. Live Google has not been exercised with person-owned accounts or the
built-in app.

## Packaging and release

The package is discovered like every workspace package (`polyth.serverEntry`,
`polyth.webEntry`); nothing is wired into the host. Only Polyth's built-in
app is ever embedded, and only by a build: `apps/desktop/build.ts` turns
`POLYTH_GOOGLE_BUILTIN_CLIENT_ID` / `POLYTH_GOOGLE_BUILTIN_CLIENT_SECRET` from
its environment into constants in the packaged server. Like any installed
app's, that ID and secret can be read out of the package; PKCE and the
loopback redirect, not the secret, protect the sign-in. Builds without those
variables, Docker images and source checkouts have no built-in app: operators
use their own client or set the variables in the server environment. The
settings routes are local-only for paired devices (`remoteAccess`), because
they manage OAuth credentials.
