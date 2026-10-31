# Handoff

Context bundles built from a session for hand-off to a new one.

## Visibility (Spaces §14.6)

Bundles are held in memory per Space. Each records its creator (`createdBy`,
never returned to clients). A bundle is visible to:

- its creator, and
- anyone who can open the session it was built from
  (`host.forSpace(space).sessions.snapshot`), since they could read the same
  conversation anyway.

A bundle with no recorded creator is visible to Space admins only. Anyone else
gets `404`, indistinguishable from a missing bundle. The 12-bundle cap and the
one-hour TTL apply per person, so one member cannot evict another's bundles.
