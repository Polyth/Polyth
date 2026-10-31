# Why Polyth Link uses Iroh

Polyth Link needs a stable endpoint identity, authenticated peers, NAT
traversal, and a direct path with encrypted relay fallback. Iroh 1.1.0
already provides those properties on QUIC, with official bindings for
Node, Swift, and Kotlin.

A custom WebSocket crypto tunnel would duplicate peer authentication,
path selection, and congestion control in application code. That is a
larger security surface and a worse transport: one TCP stream head-of-line
blocks terminal input behind file transfer.

Polyth Link therefore:

- pins `iroh = "=1.1.0"`;
- uses Iroh EndpointIds as host and device identities;
- does not add a second encryption layer;
- does not implement a parallel WSS relay protocol in v1;
- keeps pairing proofs, grants, and HTTP/WS framing in one Rust core.

Relay servers forward encrypted endpoint traffic. They are not an
application proxy and cannot be used as a source of Polyth authorization.
