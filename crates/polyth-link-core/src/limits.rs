#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub ticket_raw_bytes: usize,
    pub ticket_decoded_bytes: usize,
    pub candidates: usize,
    pub relay_urls: usize,
    pub direct_addresses: usize,
    pub label_chars: usize,
    pub control_message_bytes: usize,
    pub http_head_bytes: usize,
    pub http_path_bytes: usize,
    pub http_header_count: usize,
    pub http_header_bytes: usize,
    pub ws_message_bytes: usize,
    pub concurrent_http_streams: usize,
    pub concurrent_ws_streams: usize,
    pub active_connections_per_device: usize,
    pub per_stream_buffered_bytes: usize,
    pub aggregate_buffered_bytes: usize,
    pub pairing_ttl_ms: u64,
    pub active_invitations: usize,
    pub proof_attempts: usize,
    pub header_read_timeout_ms: u64,
    pub iroh_open_timeout_ms: u64,
    pub response_head_timeout_ms: u64,
    pub idle_body_timeout_ms: u64,
    pub local_write_timeout_ms: u64,
    pub http_body_bytes: u64,
    pub pending_nonces_per_invitation: usize,
}

impl Limits {
    pub const fn v1() -> Self {
        Self {
            ticket_raw_bytes: 16 * 1024,
            ticket_decoded_bytes: 12 * 1024,
            candidates: 4,
            relay_urls: 3,
            direct_addresses: 8,
            label_chars: 80,
            control_message_bytes: 64 * 1024,
            http_head_bytes: 64 * 1024,
            http_path_bytes: 8 * 1024,
            http_header_count: 128,
            http_header_bytes: 8 * 1024,
            ws_message_bytes: 8 * 1024 * 1024,
            concurrent_http_streams: 64,
            concurrent_ws_streams: 8,
            active_connections_per_device: 2,
            per_stream_buffered_bytes: 4 * 1024 * 1024,
            aggregate_buffered_bytes: 32 * 1024 * 1024,
            pairing_ttl_ms: 120_000,
            active_invitations: 3,
            proof_attempts: 5,
            header_read_timeout_ms: 10_000,
            iroh_open_timeout_ms: 10_000,
            response_head_timeout_ms: 30_000,
            idle_body_timeout_ms: 60_000,
            local_write_timeout_ms: 30_000,
            http_body_bytes: 64 * 1024 * 1024,
            pending_nonces_per_invitation: 4,
        }
    }
}

impl Default for Limits {
    fn default() -> Self {
        Self::v1()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v1_limits_are_bounded() {
        let limits = Limits::v1();
        assert!(limits.ticket_raw_bytes <= 16 * 1024);
        assert!(limits.concurrent_http_streams <= 64);
        assert_eq!(limits.pairing_ttl_ms, 120_000);
        assert_eq!(limits.active_connections_per_device, 2);
    }
}
