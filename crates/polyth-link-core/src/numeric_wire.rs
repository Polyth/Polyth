use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};
use zeroize::Zeroizing;

use crate::errors::LinkError;
use crate::limits::Limits;
use crate::wire::{read_len_prefixed, write_all};

pub const POLYTH_NUMERIC_ALPN: &str = "polyth-link-code/1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum NumericWireMessage {
    BootstrapRequest,
    Bootstrap {
        pairing_id: String,
        host_endpoint_id: String,
        expires_at: String,
    },
    Start {
        pairing_id: String,
        request: Vec<u8>,
    },
    Challenge {
        attempt_id: String,
        pairing_id: String,
        host_endpoint_id: String,
        expires_at: String,
        response: Vec<u8>,
    },
    Finish {
        attempt_id: String,
        finalization: Vec<u8>,
    },
    Ticket {
        ticket: String,
    },
    Rejected {
        code: String,
    },
}

pub fn encode_numeric_message(message: &NumericWireMessage) -> Result<Vec<u8>, LinkError> {
    let mut payload = Vec::new();
    ciborium::into_writer(message, &mut payload).map_err(|_| LinkError::TransportProtocolError)?;
    if payload.len() > Limits::v1().control_message_bytes {
        return Err(LinkError::RequestTooLarge);
    }
    Ok(payload)
}

pub fn decode_numeric_message(payload: &[u8]) -> Result<NumericWireMessage, LinkError> {
    if payload.len() > Limits::v1().control_message_bytes {
        return Err(LinkError::RequestTooLarge);
    }
    ciborium::from_reader(payload).map_err(|_| LinkError::TransportProtocolError)
}

pub async fn write_numeric<W: AsyncWrite + Unpin>(
    writer: &mut W,
    message: &NumericWireMessage,
) -> Result<(), LinkError> {
    let payload = Zeroizing::new(encode_numeric_message(message)?);
    write_all(writer, &(payload.len() as u32).to_be_bytes()).await?;
    write_all(writer, &payload).await
}

pub async fn read_numeric<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<NumericWireMessage, LinkError> {
    let payload = Zeroizing::new(read_len_prefixed(
        reader,
        Limits::v1().control_message_bytes,
    )
    .await?);
    decode_numeric_message(&payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_wire_round_trips_without_a_plaintext_code_field() {
        let message = NumericWireMessage::Challenge {
            attempt_id: "attempt".into(),
            pairing_id: "bootstrap-id".into(),
            host_endpoint_id: "a".repeat(52),
            expires_at: "2026-09-09T12:00:00Z".into(),
            response: vec![1, 2, 3],
        };
        let encoded = encode_numeric_message(&message).unwrap();
        assert_eq!(decode_numeric_message(&encoded).unwrap(), message);
        assert!(!String::from_utf8_lossy(&encoded).contains("482731"));
    }

    #[test]
    fn bootstrap_request_carries_no_short_code() {
        let encoded = encode_numeric_message(&NumericWireMessage::BootstrapRequest).unwrap();
        assert!(!String::from_utf8_lossy(&encoded).contains("code"));
    }

    #[test]
    fn numeric_wire_rejects_oversized_payloads() {
        let payload = vec![0u8; Limits::v1().control_message_bytes + 1];
        assert_eq!(decode_numeric_message(&payload), Err(LinkError::RequestTooLarge));
    }
}
