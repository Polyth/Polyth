# Model privacy

Marks beside model names that say how a free model's provider handles what
you send: kept or not, used for training or not, with the source and the date
it was checked.

- **Where it shows.** Providers & Models rows and every model picker row (a
  small mark after the name), the model details card (desktop hover card and
  phone details), and a chip beside the composer's model when the next turn's
  model may keep or train on the prompt or its provider does not say.
- **How it plugs in.** Row marks and details go through the models package's
  annotation seam (`@polyth/models/model-annotations`): this package registers
  plain data, the models package draws it. The chip is a `composer.config`
  slot contribution. Turning the package off in Settings → Packages removes
  all of it; Settings → Model privacy chooses whether zero-retention models
  are marked too and whether the chip shows.
- **Data.** `src/policies.ts` is a dated snapshot of the provider's own page
  (`sources`, `checkedAt`), read at build time; nothing is fetched at
  runtime. A zero-cost model the snapshot does not name is *not verified*,
  never assumed safe, and a zero-retention answer older than
  `staleAfterDays` is shown as not verified. Paid routes only get a details
  line (upstream vendor retention), never a row mark.

## Updating the snapshot

1. Re-read every URL in `POLICY_MANIFEST.sources`.
2. Update `entries` (named exceptions) and each provider's `listed` ids; keep
   retired ids with `retired: true` so old sessions still read right.
3. Set `checkedAt` to the day you read the sources.
4. Run `node --experimental-strip-types --test packages/model-privacy/test/*.test.ts`.
