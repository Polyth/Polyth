//! Polyth Link v1 protocol core.
//!
//! Security-sensitive pairing, identity, ticket parsing, and stream framing
//! live here. Language bindings must stay thin and must never return private
//! key material to JavaScript.

pub mod diagnostics;
pub mod errors;
pub mod identity;
pub mod limits;
pub mod local_proxy;
pub mod net;
pub mod pairing;
pub mod protocol;
pub mod proxy;
pub mod qr;
pub mod ticket;
pub mod transport;
pub mod wire;
pub mod words;

pub use errors::{ErrorClass, LinkError};
pub use identity::{HostIdentity, IdentityError};
pub use limits::Limits;
pub use pairing::{HostPairing, PairingEvent};
pub use ticket::{decode_invite_secret, parse_pairing_ticket, PairingTicket, POLYTH_LINK_ALPN};
pub use transport::TransportPolicy;

pub const PROTOCOL_VERSION: u16 = 1;
pub const IROH_CRATE_VERSION: &str = "1.1.0";
