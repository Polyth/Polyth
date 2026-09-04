use serde::{Deserialize, Serialize};

use crate::errors::LinkError;
use crate::limits::Limits;
use crate::PROTOCOL_VERSION;

pub const STREAM_CONTROL: u8 = 1;
pub const STREAM_HTTP: u8 = 2;
pub const STREAM_WEBSOCKET: u8 = 3;
pub const DISABLE_0RTT: bool = true;

pub const PRI_CONTROL: i32 = -100;
pub const PRI_REVOKE: i32 = -90;
pub const PRI_SESSION: i32 = -40;
pub const PRI_API: i32 = 0;
pub const PRI_FILE: i32 = 80;

pub fn is_idempotent_method(method: &str) -> bool {
    matches!(
        method.to_ascii_uppercase().as_str(),
        "GET" | "HEAD" | "OPTIONS"
    )
}

pub fn mutation_method(method: &str) -> bool {
    !is_idempotent_method(method)
}

pub fn validate_http_method(method: &str) -> Result<(), LinkError> {
    if matches!(
        method,
        "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" | "PATCH" | "DELETE"
    ) {
        Ok(())
    } else {
        Err(LinkError::RequestHeaderInvalid)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HttpRequestHeadV1 {
    pub version: u16,
    pub request_id: [u8; 16],
    pub method: String,
    pub path_and_query: String,
    pub headers: Vec<(String, String)>,
    pub body_length: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HttpResponseHeadV1 {
    pub version: u16,
    pub request_id: [u8; 16],
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body_length: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WebSocketOpenV1 {
    pub version: u16,
    pub request_id: [u8; 16],
    pub path_and_query: String,
    pub protocols: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WsFrameType {
    Text = 1,
    Binary = 2,
    Ping = 3,
    Pong = 4,
    Close = 5,
}

impl WsFrameType {
    pub fn from_u8(value: u8) -> Result<Self, LinkError> {
        match value {
            1 => Ok(Self::Text),
            2 => Ok(Self::Binary),
            3 => Ok(Self::Ping),
            4 => Ok(Self::Pong),
            5 => Ok(Self::Close),
            _ => Err(LinkError::TransportProtocolError),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum ControlMessage {
    ConnectionHello {
        version: u16,
        device_endpoint: String,
    },
    ConnectionAccepted {
        version: u16,
        connection_id: String,
        grant_revision: u32,
    },
    ConnectionRejected {
        code: String,
    },
    GrantRevisionChanged {
        grant_revision: u32,
    },
    DeviceRevoked,
    HostDescriptorUpdated {
        relay_urls: Vec<String>,
    },
    TransportStatus {
        path: String,
        rtt_ms: Option<u32>,
    },
    Ping {
        nonce: [u8; 16],
    },
    Pong {
        nonce: [u8; 16],
    },
    Shutdown {
        reason: String,
    },
    PairingHello {
        pairing_id: String,
        client_nonce: [u8; 32],
        profile: String,
        device_label: String,
        platform: String,
        app_version: String,
    },
    PairingChallenge {
        server_nonce: [u8; 32],
    },
    PairingProof {
        proof: [u8; 32],
    },
    PairingSafety {
        phrase: [String; 4],
    },
    PairingDeviceConfirmed,
    PairingCommitted {
        device_id: String,
        grant_revision: u32,
        grants: Vec<String>,
    },
    ClientStorageFailed,
}

pub fn encode_head<T: Serialize>(value: &T) -> Result<Vec<u8>, LinkError> {
    let mut payload = Vec::new();
    ciborium::into_writer(value, &mut payload).map_err(|_| LinkError::TransportProtocolError)?;
    if payload.len() > Limits::v1().http_head_bytes {
        return Err(LinkError::RequestTooLarge);
    }
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(&payload);
    Ok(out)
}

pub fn decode_head<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Result<(T, usize), LinkError> {
    if bytes.len() < 4 {
        return Err(LinkError::TransportProtocolError);
    }
    let len = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
    if len > Limits::v1().http_head_bytes || bytes.len() < 4 + len {
        return Err(LinkError::RequestTooLarge);
    }
    let value =
        ciborium::from_reader(&bytes[4..4 + len]).map_err(|_| LinkError::TransportProtocolError)?;
    Ok((value, 4 + len))
}

pub fn encode_ws_frame(kind: WsFrameType, payload: &[u8]) -> Result<Vec<u8>, LinkError> {
    if payload.len() > Limits::v1().ws_message_bytes {
        return Err(LinkError::RequestTooLarge);
    }
    if kind == WsFrameType::Text && std::str::from_utf8(payload).is_err() {
        return Err(LinkError::TransportProtocolError);
    }
    let mut out = Vec::with_capacity(5 + payload.len());
    out.push(kind as u8);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

pub fn decode_ws_frame(bytes: &[u8]) -> Result<(WsFrameType, &[u8], usize), LinkError> {
    if bytes.len() < 5 {
        return Err(LinkError::TransportProtocolError);
    }
    let kind = WsFrameType::from_u8(bytes[0])?;
    let len = u32::from_be_bytes(bytes[1..5].try_into().unwrap()) as usize;
    if len > Limits::v1().ws_message_bytes || bytes.len() < 5 + len {
        return Err(LinkError::RequestTooLarge);
    }
    let payload = &bytes[5..5 + len];
    if kind == WsFrameType::Text && std::str::from_utf8(payload).is_err() {
        return Err(LinkError::TransportProtocolError);
    }
    Ok((kind, payload, 5 + len))
}

pub fn validate_http_path(path_and_query: &str) -> Result<(), LinkError> {
    let bytes = path_and_query.as_bytes();
    if !bytes.starts_with(b"/") {
        return Err(LinkError::RequestPathDenied);
    }
    if bytes.len() > Limits::v1().http_path_bytes {
        return Err(LinkError::RequestTooLarge);
    }
    if bytes.starts_with(b"//")
        || bytes.contains(&b'#')
        || bytes
            .iter()
            .any(|byte| *byte <= b' ' || *byte == 0x7f || *byte == b'\\')
    {
        return Err(LinkError::RequestPathDenied);
    }
    let query = bytes.iter().position(|byte| *byte == b'?');
    let route = &path_and_query[..query.unwrap_or(bytes.len())];
    if route.contains("//")
        || route.contains('%')
        || route
            .split('/')
            .any(|segment| matches!(segment, "." | ".."))
    {
        return Err(LinkError::RequestPathDenied);
    }
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            index += 1;
            continue;
        }
        if index + 2 >= bytes.len() {
            return Err(LinkError::RequestPathDenied);
        }
        let decoded = decode_hex(bytes[index + 1], bytes[index + 2])?;
        let in_path = query.is_none_or(|query| index < query);
        if decoded < b' ' || decoded == 0x7f || (in_path && decoded == b' ') {
            return Err(LinkError::RequestPathDenied);
        }
        index += 3;
    }
    Ok(())
}

fn decode_hex(high: u8, low: u8) -> Result<u8, LinkError> {
    fn nibble(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }
    Ok((nibble(high).ok_or(LinkError::RequestPathDenied)? << 4)
        | nibble(low).ok_or(LinkError::RequestPathDenied)?)
}

pub fn validate_http_request_head(head: &HttpRequestHeadV1) -> Result<(), LinkError> {
    if head.version != PROTOCOL_VERSION {
        return Err(LinkError::TransportVersionUnsupported);
    }
    validate_http_method(&head.method)?;
    validate_http_path(&head.path_and_query)?;
    let body_length = head.body_length.ok_or(LinkError::RequestHeaderInvalid)?;
    if body_length > Limits::v1().http_body_bytes {
        return Err(LinkError::RequestTooLarge);
    }
    Ok(())
}

pub fn validate_websocket_open(open: &WebSocketOpenV1) -> Result<(), LinkError> {
    if open.version != PROTOCOL_VERSION {
        return Err(LinkError::TransportVersionUnsupported);
    }
    validate_http_path(&open.path_and_query)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_head_round_trip() {
        let head = HttpRequestHeadV1 {
            version: 1,
            request_id: [1u8; 16],
            method: "GET".into(),
            path_and_query: "/api/health".into(),
            headers: vec![("accept".into(), "application/json".into())],
            body_length: Some(0),
        };
        let encoded = encode_head(&head).unwrap();
        let (decoded, consumed): (HttpRequestHeadV1, usize) = decode_head(&encoded).unwrap();
        assert_eq!(consumed, encoded.len());
        assert_eq!(decoded, head);
    }

    #[test]
    fn ws_rejects_invalid_opcode_and_non_utf8_text() {
        assert!(WsFrameType::from_u8(9).is_err());
        assert!(encode_ws_frame(WsFrameType::Text, &[0xff, 0xfe]).is_err());
        let frame = encode_ws_frame(WsFrameType::Binary, &[0xff]).unwrap();
        let (kind, payload, _) = decode_ws_frame(&frame).unwrap();
        assert_eq!(kind, WsFrameType::Binary);
        assert_eq!(payload, &[0xff]);
    }

    #[test]
    fn absolute_urls_are_denied() {
        assert!(validate_http_path("http://evil/").is_err());
        assert!(validate_http_path("//evil/").is_err());
        assert!(validate_http_path("/api/health").is_ok());
    }

    #[test]
    fn hostile_request_lines_and_versions_are_denied() {
        let mut head = HttpRequestHeadV1 {
            version: PROTOCOL_VERSION,
            request_id: [0; 16],
            method: "GET".into(),
            path_and_query: "/api/health?view=full".into(),
            headers: Vec::new(),
            body_length: Some(0),
        };
        assert!(validate_http_request_head(&head).is_ok());
        head.path_and_query = "/api/search?q=hello%20world&literal=%25".into();
        assert!(validate_http_request_head(&head).is_ok());
        head.path_and_query = "/api/health?view=full".into();
        for method in ["GET\r\nX-Evil: 1", "GET\nX-Evil: 1", "get", "CONNECT"] {
            head.method = method.into();
            assert!(
                validate_http_request_head(&head).is_err(),
                "accepted {method:?}"
            );
        }
        head.method = "GET".into();
        for path in [
            "/api/health\r\nX-Evil: 1",
            "/api/health%0d%0aX-Evil:1",
            "/api/health?x=ok\r\nX-Evil:1",
            "/api/health?x=%0aX-Evil:1",
            "/api%2fadmin",
            "/api/%2e%2e/admin",
            "/api/../admin",
            "/api//admin",
            "/api\\admin",
            "/api/%zz",
        ] {
            head.path_and_query = path.into();
            assert!(
                validate_http_request_head(&head).is_err(),
                "accepted {path:?}"
            );
        }
        head.path_and_query = "/api/health".into();
        head.version = PROTOCOL_VERSION + 1;
        assert!(matches!(
            validate_http_request_head(&head),
            Err(LinkError::TransportVersionUnsupported)
        ));

        let open = WebSocketOpenV1 {
            version: PROTOCOL_VERSION + 1,
            request_id: [0; 16],
            path_and_query: "/ws".into(),
            protocols: Vec::new(),
        };
        assert!(matches!(
            validate_websocket_open(&open),
            Err(LinkError::TransportVersionUnsupported)
        ));
    }

    #[test]
    fn zero_rtt_is_disabled_in_v1() {
        if !DISABLE_0RTT {
            panic!("0-RTT must stay disabled in Polyth Link v1");
        }
        assert!(is_idempotent_method("GET"));
        assert!(mutation_method("POST"));
        assert!(!mutation_method("head"));
    }

    #[test]
    fn fuzz_cbor_heads_never_panic() {
        let mut seed = 0x243f_6a88_u64;
        for _ in 0..128 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let len = 4 + (seed % 512) as usize;
            let mut bytes = vec![0u8; len];
            for (i, slot) in bytes.iter_mut().enumerate() {
                *slot = ((seed >> ((i % 8) * 8)) as u8).wrapping_add(i as u8);
            }
            let declared = ((seed >> 8) % 70000) as u32;
            bytes[..4].copy_from_slice(&declared.to_be_bytes());
            let _ = decode_head::<HttpRequestHeadV1>(&bytes);
            let _ = decode_head::<ControlMessage>(&bytes);
            let _ = decode_ws_frame(&bytes);
        }
    }
}
