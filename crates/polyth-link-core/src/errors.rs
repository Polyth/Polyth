use std::fmt;

/// Stable error codes shared with the TypeScript contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkError {
    PairingInvalid,
    PairingExpired,
    PairingClaimed,
    PairingCancelled,
    PairingRejected,
    PairingConfirmationRequired,
    PairingStorageFailed,
    HostIdentityMismatch,
    HostIdentityCorrupt,
    HostIdentityRotated,
    DeviceUnknown,
    DeviceRevoked,
    DeviceGrantDenied,
    DeviceGrantStale,
    RelayUnreachable,
    DirectUnreachable,
    TransportUnavailable,
    TransportOutcomeUnknown,
    TransportProtocolError,
    TransportVersionUnsupported,
    ProxyBootstrapInvalid,
    ProxySessionInvalid,
    ProxyOriginDenied,
    RequestPathDenied,
    RequestHeaderInvalid,
    RequestTooLarge,
    RequestRateLimited,
    StreamLimitExceeded,
    Forbidden,
    Unauthorized,
}

impl LinkError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::PairingInvalid => "pairing-invalid",
            Self::PairingExpired => "pairing-expired",
            Self::PairingClaimed => "pairing-claimed",
            Self::PairingCancelled => "pairing-cancelled",
            Self::PairingRejected => "pairing-rejected",
            Self::PairingConfirmationRequired => "pairing-confirmation-required",
            Self::PairingStorageFailed => "pairing-storage-failed",
            Self::HostIdentityMismatch => "host-identity-mismatch",
            Self::HostIdentityCorrupt => "host-identity-corrupt",
            Self::HostIdentityRotated => "host-identity-rotated",
            Self::DeviceUnknown => "device-unknown",
            Self::DeviceRevoked => "device-revoked",
            Self::DeviceGrantDenied => "device-grant-denied",
            Self::DeviceGrantStale => "device-grant-stale",
            Self::RelayUnreachable => "relay-unreachable",
            Self::DirectUnreachable => "direct-unreachable",
            Self::TransportUnavailable => "transport-unavailable",
            Self::TransportOutcomeUnknown => "transport-outcome-unknown",
            Self::TransportProtocolError => "transport-protocol-error",
            Self::TransportVersionUnsupported => "transport-version-unsupported",
            Self::ProxyBootstrapInvalid => "proxy-bootstrap-invalid",
            Self::ProxySessionInvalid => "proxy-session-invalid",
            Self::ProxyOriginDenied => "proxy-origin-denied",
            Self::RequestPathDenied => "request-path-denied",
            Self::RequestHeaderInvalid => "request-header-invalid",
            Self::RequestTooLarge => "request-too-large",
            Self::RequestRateLimited => "request-rate-limited",
            Self::StreamLimitExceeded => "stream-limit-exceeded",
            Self::Forbidden => "forbidden",
            Self::Unauthorized => "unauthorized",
        }
    }

    pub fn retryable(&self) -> bool {
        matches!(
            self,
            Self::RelayUnreachable
                | Self::DirectUnreachable
                | Self::TransportUnavailable
                | Self::RequestRateLimited
        )
    }

    pub fn user_message(&self) -> &'static str {
        match self {
            Self::PairingInvalid | Self::PairingExpired => {
                "This pairing code is not valid. Create a new one on your computer."
            }
            Self::PairingClaimed => "This pairing code is already in use.",
            Self::PairingCancelled | Self::PairingRejected => "Pairing was cancelled.",
            Self::PairingConfirmationRequired => {
                "Confirm the safety words on both devices to continue."
            }
            Self::PairingStorageFailed => "This device could not save the pairing securely.",
            Self::HostIdentityMismatch | Self::HostIdentityRotated => {
                "This Polyth host identity changed. Pair again with a new QR code."
            }
            Self::HostIdentityCorrupt => {
                "This Polyth host identity file is unreadable. Follow identity recovery."
            }
            Self::DeviceUnknown => "This device is not paired.",
            Self::DeviceRevoked => "This device was revoked.",
            Self::DeviceGrantDenied | Self::DeviceGrantStale => {
                "This device is not allowed to do that."
            }
            Self::RelayUnreachable => "The encrypted relay is unreachable.",
            Self::DirectUnreachable => "A direct path is unavailable.",
            Self::TransportUnavailable => "The secure connection is unavailable.",
            Self::TransportOutcomeUnknown => "The request may or may not have reached the host.",
            Self::TransportProtocolError | Self::TransportVersionUnsupported => {
                "This Polyth Link version is not compatible."
            }
            Self::ProxyBootstrapInvalid | Self::ProxySessionInvalid | Self::ProxyOriginDenied => {
                "The local app session is invalid. Reopen Polyth."
            }
            Self::RequestPathDenied | Self::Forbidden => "Not allowed.",
            Self::RequestHeaderInvalid => "The request was rejected.",
            Self::RequestTooLarge => "The request is too large.",
            Self::RequestRateLimited => "Too many attempts. Try again later.",
            Self::StreamLimitExceeded => "Too many open streams.",
            Self::Unauthorized => "Authentication required.",
        }
    }
}

impl fmt::Display for LinkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for LinkError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    Retryable,
    Fatal,
    Ambiguous,
}

impl From<&LinkError> for ErrorClass {
    fn from(error: &LinkError) -> Self {
        if *error == LinkError::TransportOutcomeUnknown {
            Self::Ambiguous
        } else if error.retryable() {
            Self::Retryable
        } else {
            Self::Fatal
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_stable_and_secret_free() {
        for error in [LinkError::PairingInvalid, LinkError::HostIdentityCorrupt] {
            assert!(!error.code().contains("key"));
            assert!(!error.user_message().contains("hmac"));
        }
        assert!(LinkError::RelayUnreachable.retryable());
        assert!(!LinkError::DeviceRevoked.retryable());
    }
}
