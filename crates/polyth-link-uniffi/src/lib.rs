//! Ticket parsing FFI only. This crate is not a functional native pairing,
//! reconnect, Keychain/Keystore, or local-proxy core.

pub use polyth_link_core::{
    parse_pairing_ticket, LinkError, PairingTicket, POLYTH_LINK_ALPN, PROTOCOL_VERSION,
};

pub fn parse_ticket(raw: String) -> Result<String, String> {
    let ticket = parse_pairing_ticket(&raw).map_err(|e| e.code().to_string())?;
    Ok(ticket.host.endpoint_id)
}
