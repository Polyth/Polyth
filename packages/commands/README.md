# Commands

Slash commands, snippets and managed skills.

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
