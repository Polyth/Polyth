# Relay

Rotates a harness family's signed-in accounts: a chat pinned to `<family>-relay`
runs on one of the acting person's member accounts and moves to the next when
that one reaches its limit or refuses a turn.

The package is removable. Harness-runtime publishes the account families
(`harnessAccountFamilies` in `@polyth/harness-runtime/accounts`), resolves any
provider that declares `descriptor.relay`, and draws the Accounts section with
whatever Relay kit is registered (`@polyth/harness-runtime/relay-ui`). Without
this package there are no Relay harnesses and that section is a plain list.

## Vendor policy

Every harness family states how its vendor treats several accounts per person:
`createHarnessAccountFamily({ relay: { policy } })`.

| Policy | Relay |
|---|---|
| `prohibited` | Never offered: the terms forbid one person several accounts. |
| `unsupported` | Off until a harness manager turns it on from the warning. A family people already rotated before the switch existed stays on. Also the default for a family that states nothing. |
| `tolerated` | On unless a harness manager turns it off. |

The Relay card in Settings → Harnesses → harness → Accounts shows the notice
for the family's policy and the switch. The choice is stored once for the
deployment in `<dataDir>/packages/harness-relay/families.json`: the accounts
are logins on this host, so a suspension reaches everyone who shares them.

## Routes

| Route | Who | What |
|---|---|---|
| `GET /api/harness-relay/relays` | the person; paired devices may read | `{ relays, families }`: the caller's Relays and every family they may see with `policy`, `enabled`, `editable`, `offered` |
| `PUT /api/harness-relay/relays/:relayId` | the person, local or full access | their members, order and hand-over level |
| `PUT /api/harness-relay/families/:family` | harness managers, local or full access | `{ enabled }`; 400 under `prohibited`, 409 while chats still hold the Relay |

A person's members stay in the family's account store
(`<family>-accounts.json`), where removing an account also removes it from
every Relay.

## Layout

- `src/chooser.ts`: the pure choice of the member to run on.
- `src/family.ts`: one family's Relay harness, views and save.
- `src/serverEntry.ts`: which families have a Relay, and the routes.
- `widgets/`: the Relay card and row parts of the Accounts section.
