use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::errors::LinkError;
use crate::limits::Limits;

pub const POLYTH_LINK_ALPN: &str = "polyth-link/1";
pub const TICKET_VERSION: u32 = 1;
pub const TICKET_KIND: &str = "polyth-link-pair";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairingCandidate {
    pub kind: String,
    #[serde(rename = "endpointId")]
    pub endpoint_id: String,
    #[serde(rename = "relayUrls")]
    pub relay_urls: Vec<String>,
    #[serde(
        rename = "directAddresses",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub direct_addresses: Option<Vec<String>>,
    pub priority: u32,
    pub policy: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairingTicket {
    pub version: u32,
    pub kind: String,
    #[serde(rename = "pairingId")]
    pub pairing_id: String,
    #[serde(rename = "inviteSecret")]
    pub invite_secret: String,
    pub host: TicketHost,
    #[serde(rename = "issuedAt")]
    pub issued_at: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
    pub protocol: TicketProtocol,
    pub candidates: Vec<PairingCandidate>,
    #[serde(default = "default_profile")]
    pub profile: String,
}

fn default_profile() -> String {
    "interact".into()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketHost {
    #[serde(rename = "endpointId")]
    pub endpoint_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketProtocol {
    pub alpn: String,
    #[serde(rename = "minVersion")]
    pub min_version: u32,
    #[serde(rename = "maxVersion")]
    pub max_version: u32,
}

pub fn encode_pairing_ticket(ticket: &PairingTicket) -> Result<String, LinkError> {
    let json = serde_json::to_vec(ticket).map_err(|_| LinkError::PairingInvalid)?;
    if json.len() > Limits::v1().ticket_decoded_bytes {
        return Err(LinkError::RequestTooLarge);
    }
    let payload = URL_SAFE_NO_PAD.encode(json);
    Ok(format!("polyth://pair?v=1&t={payload}"))
}

/// Standards-based URL parser plus a fallback string parser for WebView custom schemes.
pub fn parse_pairing_ticket(raw: &str) -> Result<PairingTicket, LinkError> {
    parse_with_limits(raw, Limits::v1())
}

pub fn parse_with_limits(raw: &str, limits: Limits) -> Result<PairingTicket, LinkError> {
    if raw.len() > limits.ticket_raw_bytes {
        return Err(LinkError::RequestTooLarge);
    }
    if raw.is_empty() || raw.chars().any(|ch| ch == '\0' || ch.is_control()) {
        return Err(LinkError::PairingInvalid);
    }
    let query = extract_query(raw)?;
    let (v, t) = parse_query(&query)?;
    if v != "1" {
        return Err(LinkError::TransportVersionUnsupported);
    }
    decode_payload(&t, limits)
}

fn extract_query(raw: &str) -> Result<String, LinkError> {
    if let Ok(url) = url_query(raw) {
        return Ok(url);
    }
    fallback_query(raw)
}

fn url_query(raw: &str) -> Result<String, LinkError> {
    // `polyth://pair?v=1&t=` — some parsers treat `pair` as the host.
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix("polyth://pair?") {
        return Ok(rest.to_string());
    }
    if let Some(rest) = trimmed.strip_prefix("polyth://pair/?") {
        return Ok(rest.to_string());
    }
    Err(LinkError::PairingInvalid)
}

fn fallback_query(raw: &str) -> Result<String, LinkError> {
    let trimmed = raw.trim();
    if !trimmed.starts_with("polyth://pair") {
        return Err(LinkError::PairingInvalid);
    }
    let Some(idx) = trimmed.find('?') else {
        return Err(LinkError::PairingInvalid);
    };
    let before = &trimmed[..idx];
    if before != "polyth://pair" && before != "polyth://pair/" {
        return Err(LinkError::PairingInvalid);
    }
    if trimmed.contains('#') {
        return Err(LinkError::PairingInvalid);
    }
    Ok(trimmed[idx + 1..].to_string())
}

fn parse_query(query: &str) -> Result<(String, String), LinkError> {
    if query.contains('#') {
        return Err(LinkError::PairingInvalid);
    }
    let mut version: Option<String> = None;
    let mut ticket: Option<String> = None;
    for part in query.split('&') {
        let Some((key, value)) = part.split_once('=') else {
            return Err(LinkError::PairingInvalid);
        };
        match key {
            "v" if version.is_none() => version = Some(value.to_string()),
            "t" if ticket.is_none() => ticket = Some(value.to_string()),
            "v" | "t" => return Err(LinkError::PairingInvalid),
            _ => return Err(LinkError::PairingInvalid),
        }
    }
    match (version, ticket) {
        (Some(v), Some(t)) => Ok((v, t)),
        _ => Err(LinkError::PairingInvalid),
    }
}

fn decode_payload(t: &str, limits: Limits) -> Result<PairingTicket, LinkError> {
    if t.is_empty() || t.contains('/') || t.contains('+') || t.contains('=') {
        return Err(LinkError::PairingInvalid);
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(t.as_bytes())
        .map_err(|_| LinkError::PairingInvalid)?;
    if decoded.len() > limits.ticket_decoded_bytes {
        return Err(LinkError::RequestTooLarge);
    }
    let value: Value = serde_json::from_slice(&decoded).map_err(|_| LinkError::PairingInvalid)?;
    let ticket: PairingTicket =
        serde_json::from_value(value.clone()).map_err(|_| LinkError::PairingInvalid)?;
    validate_ticket(&ticket, &value, limits)?;
    Ok(ticket)
}

fn validate_ticket(ticket: &PairingTicket, raw: &Value, limits: Limits) -> Result<(), LinkError> {
    if ticket.version != TICKET_VERSION || ticket.kind != TICKET_KIND {
        return Err(LinkError::TransportVersionUnsupported);
    }
    if ticket.protocol.alpn != POLYTH_LINK_ALPN
        || ticket.protocol.min_version != 1
        || ticket.protocol.max_version != 1
    {
        return Err(LinkError::TransportVersionUnsupported);
    }
    if ticket.invite_secret.is_empty() || decode_b64(&ticket.invite_secret)?.len() != 32 {
        return Err(LinkError::PairingInvalid);
    }
    if decode_b64(&ticket.pairing_id)?.len() < 16 {
        return Err(LinkError::PairingInvalid);
    }
    if !valid_endpoint(&ticket.host.endpoint_id) {
        return Err(LinkError::PairingInvalid);
    }
    if let Some(label) = &ticket.host.label {
        if label.chars().count() > limits.label_chars {
            return Err(LinkError::PairingInvalid);
        }
    }
    if ticket.candidates.is_empty() || ticket.candidates.len() > limits.candidates {
        return Err(LinkError::PairingInvalid);
    }
    for candidate in &ticket.candidates {
        if candidate.kind != "iroh" {
            return Err(LinkError::PairingInvalid);
        }
        if candidate.endpoint_id != ticket.host.endpoint_id
            || !valid_endpoint(&candidate.endpoint_id)
        {
            return Err(LinkError::PairingInvalid);
        }
        if candidate.relay_urls.len() > limits.relay_urls {
            return Err(LinkError::PairingInvalid);
        }
        for relay in &candidate.relay_urls {
            validate_relay(relay)?;
        }
        if let Some(addrs) = &candidate.direct_addresses {
            if addrs.len() > limits.direct_addresses {
                return Err(LinkError::PairingInvalid);
            }
        }
        if candidate.policy != "direct-preferred"
            && candidate.policy != "relay-only"
            && candidate.policy != "air-gapped"
        {
            return Err(LinkError::PairingInvalid);
        }
    }
    if raw.get("inviteSecret").is_none() {
        return Err(LinkError::PairingInvalid);
    }
    Ok(())
}

pub fn decode_invite_secret(ticket: &PairingTicket) -> Result<[u8; 32], LinkError> {
    let bytes = decode_b64(&ticket.invite_secret)?;
    bytes.try_into().map_err(|_| LinkError::PairingInvalid)
}

fn decode_b64(value: &str) -> Result<Vec<u8>, LinkError> {
    URL_SAFE_NO_PAD
        .decode(value.as_bytes())
        .map_err(|_| LinkError::PairingInvalid)
}

fn valid_endpoint(value: &str) -> bool {
    let hex = value.len() == 64 && value.chars().all(|ch| ch.is_ascii_hexdigit());
    let z32 = value.len() >= 32
        && value.len() <= 64
        && value.chars().all(|ch| ch.is_ascii_alphanumeric());
    hex || z32
}

fn validate_relay(url: &str) -> Result<(), LinkError> {
    if url.contains('#') || url.contains('@') {
        return Err(LinkError::PairingInvalid);
    }
    let Ok(parsed) = url::Url::parse(url) else {
        return Err(LinkError::PairingInvalid);
    };
    if parsed.scheme() != "https" {
        return Err(LinkError::PairingInvalid);
    }
    if parsed.username() != "" || parsed.password().is_some() {
        return Err(LinkError::PairingInvalid);
    }
    if parsed.fragment().is_some() {
        return Err(LinkError::PairingInvalid);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> PairingTicket {
        PairingTicket {
            version: 1,
            kind: TICKET_KIND.into(),
            pairing_id: URL_SAFE_NO_PAD.encode([1u8; 16]),
            invite_secret: URL_SAFE_NO_PAD.encode([2u8; 32]),
            host: TicketHost {
                endpoint_id: "ab".repeat(32),
                label: Some("Desk".into()),
            },
            issued_at: "2026-09-03T00:00:00Z".into(),
            expires_at: "2026-09-03T00:02:00Z".into(),
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
        }
    }

    #[test]
    fn round_trip() {
        let encoded = encode_pairing_ticket(&sample()).unwrap();
        let parsed = parse_pairing_ticket(&encoded).unwrap();
        assert_eq!(parsed.host.endpoint_id, sample().host.endpoint_id);
    }

    #[test]
    fn rejects_duplicate_params_and_http_relays() {
        let encoded = encode_pairing_ticket(&sample()).unwrap();
        assert!(parse_pairing_ticket(&format!("{encoded}&v=1")).is_err());
        let mut bad = sample();
        bad.candidates[0].relay_urls = vec!["http://relay.example/".into()];
        let encoded = encode_pairing_ticket(&bad).unwrap();
        assert!(parse_pairing_ticket(&encoded).is_err());
    }

    #[test]
    fn fallback_parser_matches_url_parser() {
        let encoded = encode_pairing_ticket(&sample()).unwrap();
        assert_eq!(
            parse_pairing_ticket(&encoded).unwrap(),
            parse_pairing_ticket(&encoded.replace("polyth://pair?", "polyth://pair/?")).unwrap()
        );
    }

    #[test]
    fn oversized_payload_is_rejected() {
        let huge = "polyth://pair?v=1&t=".to_string() + &"A".repeat(20_000);
        assert_eq!(
            parse_pairing_ticket(&huge).unwrap_err(),
            LinkError::RequestTooLarge
        );
    }

    #[test]
    fn unknown_version_and_endpoint_mismatch_fail_closed() {
        let mut ticket = sample();
        ticket.version = 2;
        assert!(parse_pairing_ticket(&encode_pairing_ticket(&ticket).unwrap()).is_err());
        ticket = sample();
        ticket.candidates[0].endpoint_id = "cd".repeat(32);
        assert!(parse_pairing_ticket(&encode_pairing_ticket(&ticket).unwrap()).is_err());
    }

    #[test]
    fn random_bytes_never_panic_and_never_partially_accept() {
        for i in 0..64u8 {
            let blob = vec![i; 1024];
            let raw = String::from_utf8_lossy(&blob);
            assert!(parse_pairing_ticket(&raw).is_err());
        }
        assert!(parse_pairing_ticket("polyth://pair?v=1&t=@@@@").is_err());
    }

    #[test]
    fn fuzz_smoke_never_panics() {
        let mut seed = 0x9e37_79b9_u64;
        for _ in 0..256 {
            seed = seed.wrapping_mul(0x5851_f42d_4c95_7f2d).wrapping_add(1);
            let len = (seed % 4096) as usize;
            let bytes: Vec<u8> = (0..len)
                .map(|i| ((seed >> ((i % 8) * 8)) as u8).wrapping_add(i as u8))
                .collect();
            let raw = String::from_utf8_lossy(&bytes);
            let _ = parse_pairing_ticket(&raw);
            let prefixed = format!("polyth://pair?v=1&t={}", URL_SAFE_NO_PAD.encode(&bytes));
            let _ = parse_pairing_ticket(&prefixed);
        }
    }
}
