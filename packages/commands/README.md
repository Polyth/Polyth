# Commands

Slash commands, snippets, managed skills and the skills catalog.

## Scopes (Spaces §14.6)

| `scope` | Where | Who sees it | Who writes it |
|---|---|---|---|
| `builtin` | code | everyone | – |
| `project` | `<project>/.polyth/{commands,snippets}` | everyone who can open the project (Space-shared) | Space admins and owners only (`forbidden` otherwise) |
| `user` | `host.people.storage(userId, "commands")` | **only that person**, in every Space | that person |

Listing merges in the order builtin < project < user, so a person's own command
wins over a shared one of the same name. New commands default to `user`
(personal); `project` must be asked for explicitly. The settings page offers the
shared option to admins only.

System work (no acting person) sees builtin and project commands only and cannot
write personal ones. `ExpandContext.actorUserId` lets a caller that knows the
acting person expand that person's commands. The server expands a sent message
with a system Space context and the admitted author as `actorUserId` (a queued
message: whoever queued it), so a person's own commands expand in any chat
they send to; an unauthored turn sees builtin and project commands only.

Without `host.people` personal reads are empty and personal writes fail with
`unavailable`.

## Migration

Home-config commands and snippets (`~/.config/polyth/{commands,snippets}`) used
to be shared by everyone on the installation. They are **moved** to the first
member whose role is `owner` who lists or writes commands (never overwriting a
same-named personal file); other members never see them. Skills are unchanged.

## Skills

`src/skills.ts` keeps a Space's managed skills. `src/skillLibrary.ts` shows them
beside what every added harness has of its own, and copies a harness's skill into
Polyth. Contract and per-harness folders:
[multi-harness](../../docs/architecture/multi-harness.md#native-harness-skills);
the pages: [ui](../../docs/dev/ui.md#skills-page-skills-settings-page).

### Catalog

`src/skillCatalog.ts` reads public repositories on GitHub, GitLab and Codeberg.
Anthropic, OpenAI, Cursor and Matt Pocock are built in; a Space admin can add more
(at most 24), and removing one keeps what was installed from it.

Stored under `packageDir("commands")`, so everything is per Space:

| Path | What |
| --- | --- |
| `skills.json` | Managed skills, with `origin`, `bundleHash`, `offHarnesses` |
| `skill-bundles/<sha256>/` | A skill's files, by content. Freed with the last skill using it |
| `skill-catalog/sources.json` | Sources this Space added |
| `skill-catalog/sources/<id>/` | One archive and the index built from it |

One archive per source is the design: review and install read the same immutable
file, so what a person reviewed is byte for byte what is stored, and install needs
no network. Install names the `contentHash` it reviewed and a different one is
refused. A source is re-read after six hours, in the background, with a failed read
retried after 15 minutes while its last copy stays listed.

The security rules, each with a test in `test/skillCatalog.test.ts`:

- Repository content is data. Nothing in an archive runs at install, and bundle
  files keep only an executable bit.
- Downloads go through `@polyth/plugins`' public-HTTPS broker, which refuses private
  addresses and checks redirects. A source must be a supported forge's repository.
- `openZipArchive` lists and reads without extracting: unsafe paths refuse the whole
  archive, links are skipped, and each read has a size limit.
- A source picture reaches the page only as a PNG or JPEG recognized by its bytes.
- Installing to a project needs `member`, to the Space `admin`, as do sources. A
  project id from another Space looks like one that does not exist.
- The host's own skill folders are read only on a local, single-user Polyth.

Install limits: 1024 files, 16 MB, 8 MB per file, 256 KB of instructions. Larger
skills stay listed and say why they cannot be installed.
