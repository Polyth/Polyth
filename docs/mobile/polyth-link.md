# Polyth Link on mobile

Primary flow, when a native Polyth Link adapter is installed: scan or paste
`polyth://pair?v=1&t=…`, compare four words, wait for the computer to allow
the device, then load the canonical UI from a local loopback proxy.

This repository does **not** yet ship production Android/iOS native pairing.
`polyth-link-uniffi` only parses pairing tickets. Until a real native adapter
is installed, QR pairing stays hidden and the UI says Polyth Link is
unavailable in this build.

Raw server URLs are **Insecure development connections**. They are not
paired devices and must not auto-connect in production.

## Storage

A pairing ticket scanned or pasted in this app session is kept in memory so
it can be retried until it expires or the process restarts. It is not written
to Preferences, localStorage, or any other durable store — the ticket contains
a short-lived invite secret.

Preferences may later hold connection ids, labels, EndpointIds, last
transport, and non-secret relay URLs. Device keys must stay in the OS secure
store via a native core that does not exist in this build. They never enter
`localStorage`, Preferences, SQLite visible to the renderer, or the QR.

This build does not implement Keychain, Keystore, native reconnect, path
migration, or local proxy restore.

## Deep links

- `polyth://pair?…` is pairing only.
- `polyth://open?project=…` / `session=…` wait until a connection exists,
  then apply once. Credentials are not copied from the URL.

## Resume

Native reconnect of a saved host EndpointId is not included yet. After
expiration or app restart, scan a new QR.
