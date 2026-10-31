use crate::ticket::POLYTH_LINK_ALPN;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportPolicy {
    DirectPreferred,
    RelayOnly,
    AirGapped,
}

impl TransportPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DirectPreferred => "direct-preferred",
            Self::RelayOnly => "relay-only",
            Self::AirGapped => "air-gapped",
        }
    }

    pub fn advertise_direct(self) -> bool {
        matches!(self, Self::DirectPreferred)
    }

    pub fn allow_public_relays(self) -> bool {
        !matches!(self, Self::AirGapped)
    }
}

pub fn alpn_bytes() -> Vec<u8> {
    POLYTH_LINK_ALPN.as_bytes().to_vec()
}

/// Iroh already selects direct vs relay for one EndpointId. Polyth Link uses
/// a single connection and must not race independent transports.
pub fn single_logical_connection() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn air_gapped_disables_public_relays() {
        assert!(!TransportPolicy::AirGapped.allow_public_relays());
        assert!(!TransportPolicy::RelayOnly.advertise_direct());
        assert_eq!(alpn_bytes(), b"polyth-link/1");
        assert!(single_logical_connection());
    }
}
