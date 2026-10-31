# Host identity recovery

The host identity file is `<dataDir>/tunnel/identity`.

Generation happens only when the authoritative read returns not found.
Permission errors, truncation, checksum mismatch, and unknown versions
fail closed. Polyth will not mint a new EndpointId to “fix” a read error.

## Recovery

1. Stop Polyth.
2. Restore the identity file from a known-good backup, or accept that every
   pairing is invalid.
3. If rotating: use Settings → Polyth Link → Rotate host identity. This
   revokes device trust and requires new QR pairing.
4. File mode must be `0600`, directory `0700`.

Do not copy an identity file onto two running hosts. EndpointIds would
collide and pairings become unsafe.
