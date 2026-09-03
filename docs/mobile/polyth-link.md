# Polyth Link on mobile

Primary flow: scan or paste `polyth://pair?v=1&t=…`, compare four words,
wait for the computer to allow the device, then load the canonical UI from
a local loopback proxy.

Raw server URLs are **Insecure development connections**. They are not
paired devices and must not auto-connect in production.

## Storage

Preferences may hold connection ids, labels, EndpointIds, last transport,
and non-secret relay URLs. Device keys stay in the OS secure store via the
native core. They never enter `localStorage`, Preferences, SQLite visible
to the renderer, or the QR.

## Deep links

- `polyth://pair?…` is pairing only.
- `polyth://open?project=…` / `session=…` wait until connection restore,
  then apply once. Credentials are not copied from the URL.

## Resume

On foreground and network change the native core reconnects the same host
EndpointId, restores the proxy, and lets the canonical WebSocket fill gaps
with `afterSeq`. Path migration is not a new host.
