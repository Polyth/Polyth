//! Thin mobile FFI. Pairing, ticket validation, and stream framing stay in
//! `polyth-link-core`. Private keys are never returned.

pub use polyth_link_core::{
    parse_pairing_ticket, LinkError, PairingTicket, POLYTH_LINK_ALPN, PROTOCOL_VERSION,
};

pub fn parse_ticket(raw: String) -> Result<String, String> {
    let ticket = parse_pairing_ticket(&raw).map_err(|e| e.code().to_string())?;
    Ok(ticket.host.endpoint_id)
}
