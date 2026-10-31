// Append-only v7: first-party background/runtime work gets its own durable
// principal instead of impersonating the installation owner. It is not a user,
// carries no login credential and receives no ambient organization/Space role.
export const runtimeSystemMigration = String.raw`
INSERT OR IGNORE INTO principals(id,kind,status,revision)
VALUES('system:polyth-runtime','system','active',1);
`;
