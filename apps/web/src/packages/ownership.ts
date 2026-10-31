/** Sentinel owner for host/core contributions that were not package-activated. */
export const HOST_OWNER_ID = "host";

export function ownerId(ownerPackageId: string | undefined): string {
  return ownerPackageId ?? HOST_OWNER_ID;
}

export function assertOwnerCanReplace(args: {
  registry: string;
  id: string;
  existingOwner: string | undefined;
  nextOwner: string | undefined;
}): void {
  const existing = ownerId(args.existingOwner);
  const next = ownerId(args.nextOwner);
  if (existing === next) return;
  throw new Error(
    `${args.registry} "${args.id}" is owned by "${existing}"; "${next}" cannot replace it`,
  );
}
