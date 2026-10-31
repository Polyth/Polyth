# Personal Coach

Durable goals, commitments, routines and check-ins for one person.

## Data ownership (Spaces §14.6)

Coach data is private to **one person in one Space**. It is stored at
`<dataDir>/people/<userId>/packages/personal-coach/spaces/<spaceId>/coach.db`
(`host.people.storage`), never in the Space.

- Routes use `rc.space.userId`; agent tools use `ToolExecutionContext.actorUserId`
  resolved to a member via `host.personSpaceContext`. A turn with no acting person
  (scheduled system work, an unowned session) is refused with `forbidden`.
- Reminders (Schedule tasks) are owned by the person who configured them
  (`ownerUserId`), so their runs act for that person. Tasks made before person
  ownership have no owner; they are paused on enable and replaced the next time
  anyone configures reminders.
- Without `host.people` every data call fails closed with `unavailable`.

## Migration

The pre-person Space database (`<space>/packages/personal-coach/coach.db`, with
its `-wal`/`-shm`) is **moved** to the first request by a member whose role is
`owner`. It is never copied to anyone else, never overwrites an existing
database of the owner, and other members start empty. If a Space has several
owners the first to open Coach receives it.
