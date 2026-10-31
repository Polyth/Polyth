# Markets

Quotes, charts, screener, calendars and research. Market data is public and
shared; **watchlists and the portfolio are private to one person in one Space**.

## Data ownership (Spaces §14.6)

`<dataDir>/people/<userId>/packages/markets/spaces/<spaceId>/{watchlists,portfolio}.json`
via `host.people.storage` (see `src/personal.ts`). Routes use `rc.space.userId`;
system principals are refused with `forbidden`, and a host without `host.people`
fails closed with `unavailable`.

## Migration

The pre-person files in `<space>/packages/markets/` are **moved** to the first
request by a member whose role is `owner` (never overwriting an existing file of
theirs). Other members start from the defaults.
