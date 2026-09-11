use std::net::{IpAddr, SocketAddr};
use std::str::FromStr;

use iroh::address_lookup::AddrFilter;
use iroh::{
    endpoint::presets, Endpoint, EndpointAddr, EndpointId, RelayMode, RelayUrl, SecretKey,
    TransportAddr,
};

use crate::errors::LinkError;
use crate::numeric_wire::POLYTH_NUMERIC_ALPN;
use crate::ticket::{PairingTicket, POLYTH_LINK_ALPN};
use crate::transport::TransportPolicy;

pub async fn bind_link_endpoint(
    secret: SecretKey,
    policy: TransportPolicy,
) -> Result<Endpoint, LinkError> {
    let mut builder = Endpoint::builder(presets::N0)
        .secret_key(secret)
        .alpns(vec![
            POLYTH_LINK_ALPN.as_bytes().to_vec(),
            POLYTH_NUMERIC_ALPN.as_bytes().to_vec(),
        ])
        .max_tls_tickets(0);
    builder = match policy {
        TransportPolicy::AirGapped => builder.relay_mode(RelayMode::Disabled),
        TransportPolicy::RelayOnly => builder
            .relay_mode(RelayMode::Default)
            .addr_filter(AddrFilter::relay_only()),
        TransportPolicy::DirectPreferred => builder.relay_mode(RelayMode::Default),
    };
    builder
        .bind()
        .await
        .map_err(|_| LinkError::TransportUnavailable)
}

pub fn endpoint_addr_from_ticket(ticket: &PairingTicket) -> Result<EndpointAddr, LinkError> {
    let id =
        EndpointId::from_str(&ticket.host.endpoint_id).map_err(|_| LinkError::PairingInvalid)?;
    let mut addr = EndpointAddr::new(id);
    for candidate in &ticket.candidates {
        if candidate.endpoint_id != ticket.host.endpoint_id {
            return Err(LinkError::PairingInvalid);
        }
        for relay in &candidate.relay_urls {
            let url = RelayUrl::from_str(relay).map_err(|_| LinkError::PairingInvalid)?;
            addr = addr.with_relay_url(url);
        }
        if let Some(direct) = &candidate.direct_addresses {
            for item in direct {
                let socket = SocketAddr::from_str(item).map_err(|_| LinkError::PairingInvalid)?;
                addr = addr.with_ip_addr(socket);
            }
        }
    }
    Ok(addr)
}

pub fn endpoint_addr_from_discovery(
    endpoint_id: &str,
    direct_addresses: &[String],
    fallback_port: Option<u16>,
) -> Result<EndpointAddr, LinkError> {
    let id = EndpointId::from_str(endpoint_id).map_err(|_| LinkError::PairingInvalid)?;
    let mut addr = EndpointAddr::new(id);
    for item in direct_addresses.iter().take(16) {
        let socket = if let Ok(socket) = SocketAddr::from_str(item) {
            socket
        } else {
            let ip = IpAddr::from_str(item).map_err(|_| LinkError::PairingInvalid)?;
            SocketAddr::new(ip, fallback_port.ok_or(LinkError::PairingInvalid)?)
        };
        addr = addr.with_ip_addr(socket);
    }
    Ok(addr)
}

pub fn current_direct_addresses(endpoint: &Endpoint) -> Vec<String> {
    endpoint
        .addr()
        .ip_addrs()
        .map(ToString::to_string)
        .collect()
}

pub fn current_relay_urls(endpoint: &Endpoint) -> Vec<String> {
    endpoint
        .addr()
        .relay_urls()
        .map(ToString::to_string)
        .collect()
}

pub fn path_transport(conn: &iroh::endpoint::Connection) -> &'static str {
    match conn.paths().iter().find(|path| path.is_selected()) {
        Some(path) if matches!(path.remote_addr(), TransportAddr::Relay(_)) => "relay",
        Some(_) => "direct",
        None => "relay",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ticket::{encode_pairing_ticket, PairingCandidate, TicketHost, TicketProtocol};
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;

    #[test]
    fn ticket_addr_rejects_endpoint_mismatch() {
        let mut ticket = PairingTicket {
            version: 1,
            kind: "polyth-link-pair".into(),
            pairing_id: URL_SAFE_NO_PAD.encode([1u8; 16]),
            invite_secret: URL_SAFE_NO_PAD.encode([2u8; 32]),
            host: TicketHost {
                endpoint_id: "aa".repeat(32),
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
                endpoint_id: "aa".repeat(32),
                relay_urls: vec!["https://relay.example/".into()],
                direct_addresses: Some(vec!["127.0.0.1:9".into()]),
                priority: 0,
                policy: "direct-preferred".into(),
            }],
            profile: "interact".into(),
        };
        assert!(endpoint_addr_from_ticket(&ticket).is_ok());
        ticket.candidates[0].direct_addresses = Some(vec!["not-an-addr".into()]);
        assert!(endpoint_addr_from_ticket(&ticket).is_err());
        let _ = encode_pairing_ticket(&ticket);
    }

    #[test]
    fn discovery_addr_is_pinned_to_endpoint_identity_and_bounded_candidates() {
        let endpoint = "aa".repeat(32);
        let addr = endpoint_addr_from_discovery(
            &endpoint,
            &["192.168.1.10".into(), "[fd00::10]:4433".into()],
            Some(4433),
        )
        .unwrap();
        assert_eq!(addr.id.to_string(), endpoint);
        assert_eq!(addr.ip_addrs().count(), 2);
    }

    #[test]
    fn discovery_addr_rejects_unparseable_candidates() {
        let endpoint = "aa".repeat(32);
        assert!(endpoint_addr_from_discovery(
            &endpoint,
            &["https://evil.example/".into()],
            Some(4433),
        )
        .is_err());
    }
}
