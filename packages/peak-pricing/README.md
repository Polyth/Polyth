# @polyth/peak-pricing

A quiet chip on the composer's model row that answers one question: **is the
selected route billed at peak or off-peak today, and when does that change?**

- Green dot, `Off-peak` and the remaining time while the off-peak rate applies.
- Red dot, `Peak` and the remaining time while the peak rate applies.
- The arc around the dot is the progress through the current phase.
- Hover (or keyboard focus) shows the countdown and the exact change time;
  click/tap opens the full card with the UTC and local window table, the
  holiday calendar provenance and the provider's pricing page.
- Nothing renders for a model whose provider does not publish a time-of-day
  price, so the row never grows a dead control.

## Status bar

The same chip is a status-bar segment, `peak-pricing.statusbar` (default at the
trailing end, visible whenever the bar is on, hideable and movable between the
ends from the bar's Customize menu). The bar gives widgets only the active
project and session, so the segment reads the route from the host: the open
session's model and resolved harness, or a new chat's draft route
(`host.executionDraft`). An unsent model switch in the composer is shown by the
composer chip only. It draws the host `.sb` segment instead of `.config-chip`
(markup carries `data-surface="statusbar"`), keeps the ring, the phase colour,
the hover summary and the click card, and follows **Display**; **Show the chip**
governs the composer only, since the bar's own layout decides whether the
segment is there.

## Settings

Settings → Peak pricing (Engineering) chooses how much of the chip shows. The
record (`widgets/prefs.ts`, key `polyth.peakPricingPrefs`) syncs with the
account as `package.peak-pricing`:

- **Show the chip** (`enabled`, default on). Off renders nothing.
- **Display** (`display`): `full` (default — state word and countdown),
  `compact` (state word only) or `dot` (only the phase dot and its arc, 2px
  after the model chip, with no chip chrome; a 24×30 hit box, 44×44 on touch).
  The 2px is measured from the host model control's box, so on desktop and
  phone alike the dot reads about 15px after the chevron: that control's own
  8px end padding, 1px border and the chevron's inner whitespace come first.
- **Show a summary on hover** (`tooltip`, default on). Off drops the hover
  summary; a click still opens the card, and the accessible name always
  carries the state and the end time.

The page's preview draws the same `PeakPricingChip` the composer uses. Copy,
including countdown units (`1h 21m`, `1 год 21 хв`), is in `widgets/copy.ts`
(EN and UK). The chip uses the host `.config-chip` primitive; only its glyph,
the 6px rhythm and the dot-only geometry live in `widgets/styles.css`.

## Which routes it covers

Provider identity decides first, not harness identity: DeepSeek's own routes
(`deepseek`, `deepseek-official`, `deepseek-platform`) and any
`deepseek-<account>` harness login. A DeepSeek model resold by another provider
(OpenRouter, Together, a local runtime, …) still gets the chip, because it is
still a DeepSeek model, but the card names that provider and says the clock is
DeepSeek's own API price — the route itself may bill differently. A model with
neither a scheduled provider nor a DeepSeek identity renders nothing.

## The clock

From [DeepSeek's pricing page](https://api-docs.deepseek.com/quick_start/pricing):

> Peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday through Friday,
> excluding Chinese public holidays. All other hours are off-peak, including
> weekends and Chinese public holidays in full. Off-peak rates are half of the
> peak rates.

The implementation (`src/schedule.ts`) evaluates those windows in **UTC**, so
the answer never depends on the device zone:

- A phase changes only at a UTC midnight or a window edge, so
  `priceStateAt(now)` finds the current phase and its exact start/end by
  walking outward until the phase actually changes — not by polling and not by
  minute-stepping. One off-peak run can span a weekend plus a nine-day holiday.
- The holiday calendar lives in `src/holidays.ts` and only encodes a published
  State Council notice (2026: 国办发明电〔2025〕7号). Holiday dates are matched in
  Asia/Shanghai, because the notice is written in Beijing dates while the price
  windows are UTC. Outside the covered year the clock still uses weekday
  windows and the card says that the holiday calendar is not published yet; it
  never guesses a holiday date.
- The card's local window row is rendered on the current date, so it stays
  correct across daylight-saving changes.
- The full chip ticks once a second while visible (so does any display while
  its summary or card is open); compact and dot-only only move the arc, so
  they tick every 30 s, and the phase edge always has its own exact timeout.
  A hidden tab stops every timer. A route change closes the card.

## Extending it

Add a `PricingSchedule` to `PRICING_SCHEDULES` with the provider ids, UTC
windows, weekdays and (when applicable) a holiday calendar. The indicator is
unchanged: it looks up the effective route's schedule and renders nothing when
there is none.
