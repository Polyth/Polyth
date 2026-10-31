use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
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

/// Packs a square module matrix into one bit per module instead of a JSON
/// boolean array. A JSON `Vec<Vec<bool>>` costs ~5-6 bytes per module (the
/// text "false,"), which lets a single mid-size QR (already legal under the
/// ticket/label/candidate limits in `Limits::v1()`) blow past
/// `Limits::control_message_bytes` on the host control socket even though
/// the source ticket is a few hundred bytes. Packed bits keep the largest
/// possible QR (version 40, 177x177) under 4 KiB raw, ~6 KiB once
/// base64-encoded for the control-socket wire — comfortably inside
/// `control_message_bytes` instead of racing past it.
pub fn pack_qr_modules(modules: &[Vec<bool>]) -> (usize, String) {
    let size = modules.len();
    let mut bits = vec![0u8; size.saturating_mul(size).div_ceil(8)];
    let mut index = 0usize;
    for row in modules {
        for &on in row {
            if on {
                bits[index / 8] |= 1 << (7 - (index % 8));
            }
            index += 1;
        }
    }
    (size, BASE64.encode(bits))
}

#[cfg(test)]
fn unpack_qr_modules(size: usize, packed: &str) -> Vec<Vec<bool>> {
    let bits = BASE64.decode(packed).unwrap();
    let mut modules = Vec::with_capacity(size);
    let mut index = 0usize;
    for _ in 0..size {
        let mut row = Vec::with_capacity(size);
        for _ in 0..size {
            let byte = bits[index / 8];
            row.push(byte & (1 << (7 - (index % 8))) != 0);
            index += 1;
        }
        modules.push(row);
    }
    modules
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

    #[test]
    fn packed_modules_round_trip_and_stay_small() {
        // A synthetic worst-case matrix: the largest standard QR version.
        let size = 177;
        let modules: Vec<Vec<bool>> = (0..size)
            .map(|y| (0..size).map(|x| (x + y) % 3 == 0).collect())
            .collect();
        let (packed_size, bits) = pack_qr_modules(&modules);
        assert_eq!(packed_size, size);
        // Packed as bits and base64, this must stay far under the 64 KiB
        // control-message budget the naive JSON boolean array could exceed
        // (a JSON `Vec<Vec<bool>>` for this same matrix runs past 170 KiB).
        assert!(bits.len() < 8 * 1024, "packed size was {}", bits.len());
        assert_eq!(unpack_qr_modules(packed_size, &bits), modules);
    }
}
