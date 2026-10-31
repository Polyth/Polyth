# Identity migration preparation

This operator workflow prepares PT-009 inputs. It **does not activate** the new
identity package, migrate the running installation, claim the entire blueprint is
complete, or replace a tested full-installation backup/rollback procedure.

## Safe boundary

Stop Polyth and all writers of the legacy data directory before staging. The tool
has no permission to kill a process or stop a remote installation. `--offline` is
an explicit operator acknowledgement, not a remote shutdown or a filesystem lock.
Before/after hashes detect changed inputs but cannot exclude arbitrary JSON writers.
Use synthetic fixtures until the remaining authority switch-over is qualified.

A capsule contains exactly the identity-migration inputs: `auth.json`,
`tenancy.json`, `projects.json`, a self-contained snapshot of `sessions.db`, and
`agent-profile-owners.json`. Absent sources and blocked backup coverage are
recorded explicitly. The SQLite snapshot preserves every table and committed WAL
content, including tables unknown to the identity migrator. Source content is
never rewritten. SQLite may create empty WAL/SHM coordination files when reading
a checkpointed WAL database; these are not new application data.

The capsule is sensitive: authentication hashes and private session history may
be present. It uses private directories (0700) and files (0600) on POSIX. Do not
attach real capsules to issues, publish them as CI artifacts, or send them to a
model. Project working trees, attachments, runtime state, secret-vault root keys,
and other installation assets are **not** covered by this scoped capsule.

## Commands

Run from the repository root using the declared Node version and installed
workspaces. Paths below are placeholders, never production defaults.

```sh
node --experimental-strip-types scripts/migrate-identity.ts inspect \
  --data-dir /isolated/legacy-data

node --experimental-strip-types scripts/migrate-identity.ts stage \
  --data-dir /isolated/legacy-data \
  --stage-dir /isolated/new-capsule \
  --expect-inventory <inventoryDigest-from-inspect> \
  --offline

node --experimental-strip-types scripts/migrate-identity.ts verify \
  --stage-dir /isolated/new-capsule \
  --expect-manifest <manifestDigest-from-stage>
```

`--profile-owners-file` is available on inspect/stage only for an explicit legacy
operator path. It is not accepted from a network request or capsule manifest.
The stage's parent must exist. Stage and source directories must not overlap.
Unmanaged existing output directories, symlinks, hardlinks and public-readable
capsule files are rejected, not repaired or overwritten. Record the returned
manifest digest separately. A checksum proves integrity against that recorded
value; it does not authenticate an untrusted imported capsule or grant access.

Exit code 0 means an issue-free inventory or an integrity-verified capsule.
Exit code 2 means review/quarantine is required. Exit code 1 means failure/usage.
None of these codes authorizes starting a server against migrated data.

## Checkpoints, interruption and quarantine

`migration.sqlite` is an operator checkpoint journal, not a user/session authority.
Its lock serializes staging processes; there is no stale PID lock to bypass.
A committed `copying` record pins the source inventory before copying starts.
Copied artifacts and the final `verified`/`quarantined` record commit together,
after their files and directories have been flushed. On interruption, retry with
the same source digest and stage directory: only that initialized incomplete
stage's fixed uncommitted artifact paths are discarded and rebuilt. Unknown files
and corruption require operator investigation and are never silently removed.

A completed stage is reused only after every artifact hash is revalidated. It
keeps the same ID and manifest on repeat, without duplicating users/resources.
Independent `verify` works even when the original source is unavailable. A changed
source requires a new dry-run and a new capsule; an old capsule is not repurposed.

Any review or blocking issue results in quarantine, including overlapping project
roots, conflicting ownership, malformed sources and incomplete backup coverage.
`safeToStage` on an inventory means evidence can be collected, **not** that the
resources may be adopted. Unresolved rows stay named in the private manifest;
no fallback `usr_owner`, current browser user or display name resolves them.

## Remaining switch-over gates

A verified input snapshot still needs a reviewed ownership/identity mapping,
credential proof, explicit storage-identity preservation, new-authority staging,
full asset backup with restore exercise, generation fencing, coherent server and
background-consumer switch-over, and rollback qualification. This command exposes
no `apply`, `restore-over-live`, network route or automatic startup migration.
