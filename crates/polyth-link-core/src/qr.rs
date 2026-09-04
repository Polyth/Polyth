use qrcode::QrCode;

use crate::errors::LinkError;
use crate::limits::Limits;

/// Byte-mode QR modules for a pairing ticket. The matrix is the only encoder
/// the UI should use so web and native scans share one payload.
pub fn ticket_qr_modules(ticket: &str) -> Result<Vec<Vec<bool>>, LinkError> {
    if ticket.len() > Limits::v1().ticket_raw_bytes {
        return Err(LinkError::RequestTooLarge);
    }
    let code = QrCode::new(ticket.as_bytes()).map_err(|_| LinkError::PairingInvalid)?;
    let width = code.width();
    let mut modules = Vec::with_capacity(width);
    for y in 0..width {
        let mut row = Vec::with_capacity(width);
        for x in 0..width {
            row.push(code[(x, y)] == qrcode::Color::Dark);
        }
        modules.push(row);
    }
    Ok(modules)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ticket::{
        encode_pairing_ticket, PairingCandidate, PairingTicket, TicketHost, TicketProtocol,
        POLYTH_LINK_ALPN,
    };
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;

    #[test]
    fn qr_matrix_is_square_and_finder_like() {
        let ticket = encode_pairing_ticket(&PairingTicket {
            version: 1,
            kind: "polyth-link-pair".into(),
            pairing_id: URL_SAFE_NO_PAD.encode([1u8; 16]),
            invite_secret: URL_SAFE_NO_PAD.encode([2u8; 32]),
            host: TicketHost {
                endpoint_id: "ab".repeat(32),
                label: None,
            },
            issued_at: "t0".into(),
            expires_at: "t1".into(),
            protocol: TicketProtocol {
                alpn: POLYTH_LINK_ALPN.into(),
                min_version: 1,
                max_version: 1,
            },
            candidates: vec![PairingCandidate {
                kind: "iroh".into(),
                endpoint_id: "ab".repeat(32),
                relay_urls: vec!["https://relay.example/".into()],
                direct_addresses: None,
                priority: 0,
                policy: "direct-preferred".into(),
            }],
            profile: "interact".into(),
        })
        .unwrap();
        let modules = ticket_qr_modules(&ticket).unwrap();
        assert!(!modules.is_empty());
        assert_eq!(modules.len(), modules[0].len());
        assert!(modules[0][0]);
    }
}
