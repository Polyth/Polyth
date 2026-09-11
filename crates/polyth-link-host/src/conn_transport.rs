use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use iroh::endpoint::{Connection, RecvStream, SendStream};
use polyth_link_core::errors::LinkError;
use polyth_link_core::http_io::{copy_exact, pump_local_http_response, read_http_head, PrefixedIo};
use polyth_link_core::limits::Limits;
use polyth_link_core::net::path_transport;
use polyth_link_core::protocol::{
    decode_head, encode_head, mutation_method, ControlMessage, HttpRequestHeadV1,
    HttpResponseHeadV1, WebSocketOpenV1, PRI_API, PRI_CONTROL, PRI_FILE, STREAM_CONTROL,
    STREAM_HTTP, STREAM_WEBSOCKET,
};
use polyth_link_core::proxy::{allowed_http_path, sanitize_headers};
use polyth_link_core::wire::{
    open_control, read_control, read_len_prefixed, read_stream_kind, write_all, write_control,
    ControlReader,
};
use polyth_link_core::ws_local::{
    client_from_upgraded, proxy_tungstenite_to_link, verify_upstream_switch,
};
use polyth_link_core::PROTOCOL_VERSION;
use rand::RngCore;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tokio::sync::{broadcast, Mutex};

use crate::{HostState, LiveConnection, TrustedDevice};

pub async fn accept_loop(state: Arc<Mutex<HostState>>, endpoint: iroh::Endpoint) {
    loop {
        let incoming = match endpoint.accept().await {
            Some(incoming) => incoming,
            None => break,
        };
        let connecting = match incoming.accept() {
            Ok(connecting) => connecting,
            Err(_) => continue,
        };
        let connection = match connecting.await {
            Ok(connection) => connection,
            Err(_) => continue,
        };
        if connection.alpn() != polyth_link_core::POLYTH_LINK_ALPN.as_bytes() {
            connection.close(0u32.into(), b"alpn");
            continue;
        }
        let peer = connection.remote_id().to_string();
        let state = state.clone();
        tokio::spawn(async move {
            let _ = handle_connection(state, connection, peer).await;
        });
    }
}

pub async fn handle_connection(
    state: Arc<Mutex<HostState>>,
    connection: Connection,
    peer: String,
) -> Result<(), LinkError> {
    let (send, mut recv) = connection
        .accept_bi()
        .await
        .map_err(|_| LinkError::TransportProtocolError)?;
    if recv.is_0rtt() {
        connection.close(0u32.into(), b"0rtt");
        return Err(LinkError::TransportProtocolError);
    }
    let _ = send.set_priority(PRI_CONTROL);
    let kind = read_stream_kind(&mut recv).await?;
    if kind != STREAM_CONTROL {
        connection.close(0u32.into(), b"protocol");
        return Err(LinkError::TransportProtocolError);
    }

    let trusted = {
        let guard = state.lock().await;
        guard.trust.get(&peer).cloned()
    };

    if let Some(device) = trusted {
        if let Err(error) = validate_connection_hello(read_control(&mut recv).await?, &peer) {
            connection.close(0u32.into(), b"protocol");
            return Err(error);
        }
        return serve_trusted(state, connection, send, recv, peer, device).await;
    }

    serve_pairing(state, connection, send, recv, peer).await
}

fn validate_connection_hello(message: ControlMessage, peer: &str) -> Result<(), LinkError> {
    match message {
        ControlMessage::ConnectionHello {
            version,
            device_endpoint: _,
        } if version != PROTOCOL_VERSION => Err(LinkError::TransportVersionUnsupported),
        ControlMessage::ConnectionHello {
            device_endpoint, ..
        } if device_endpoint != peer => Err(LinkError::HostIdentityMismatch),
        ControlMessage::ConnectionHello { .. } => Ok(()),
        _ => Err(LinkError::TransportProtocolError),
    }
}

async fn serve_pairing(
    state: Arc<Mutex<HostState>>,
    connection: Connection,
    mut send: SendStream,
    mut recv: RecvStream,
    peer: String,
) -> Result<(), LinkError> {
    let hello = match read_control(&mut recv).await? {
        ControlMessage::PairingHello {
            pairing_id,
            client_nonce,
            profile: _,
            device_label,
            platform,
            app_version,
        } => (
            pairing_id,
            client_nonce,
            device_label,
            platform,
            app_version,
        ),
        _ => {
            write_control(
                &mut send,
                &ControlMessage::ConnectionRejected {
                    code: "pairing-invalid".into(),
                },
            )
            .await?;
            return Err(LinkError::PairingInvalid);
        }
    };
    let (pairing_id, client_nonce, device_label, platform, app_version) = hello;
    let host_endpoint;
    let server_nonce;
    {
        let mut guard = state.lock().await;
        host_endpoint = guard.identity.endpoint_id();
        server_nonce = guard
            .pairing
            .challenge(&pairing_id, &peer, client_nonce, Instant::now())
            .inspect_err(|_| {
                let _ = guard.events.send(json!({
                    "type": "tunnel/pairing-proof-failed",
                    "pairingId": pairing_id,
                }));
            })?;
        let _ =
            guard
                .pairing
                .note_device(&pairing_id, &peer, &device_label, &platform, &app_version);
    }
    write_control(
        &mut send,
        &ControlMessage::PairingChallenge { server_nonce },
    )
    .await?;

    let proof = match read_control(&mut recv).await? {
        ControlMessage::PairingProof { proof } => proof,
        _ => return Err(LinkError::PairingInvalid),
    };
    let phrase = {
        let mut guard = state.lock().await;
        let phrase = guard.pairing.verify_proof(
            &pairing_id,
            &host_endpoint,
            &peer,
            &client_nonce,
            &server_nonce,
            &proof,
            Instant::now(),
        )?;
        let _ = guard.events.send(json!({
            "type": "tunnel/pairing-claimed",
            "pairingId": pairing_id,
            "endpointId": peer,
        }));
        let _ = guard.events.send(json!({
            "type": "tunnel/pairing-updated",
            "pairingId": pairing_id,
            "state": "proof-verified",
            "safetyPhrase": phrase,
        }));
        phrase
    };
    write_control(&mut send, &ControlMessage::PairingSafety { phrase }).await?;

    let mut control = ControlReader::new(recv);
    loop {
        tokio::select! {
            message = control.read() => {
                match message? {
                    ControlMessage::PairingDeviceConfirmed => {
                        let mut guard = state.lock().await;
                        guard.pairing.confirm_device(&pairing_id, &peer, Instant::now())?;
                        crate::maybe_emit_committing(&guard, &pairing_id);
                    }
                    ControlMessage::ClientStorageFailed => {
                        let mut guard = state.lock().await;
                        let _ = guard.pairing.mark_storage_failed(&pairing_id);
                        let _ = guard.events.send(json!({
                            "type": "tunnel/pairing-storage-failed",
                            "pairingId": pairing_id,
                            "endpointId": peer,
                        }));
                        return Err(LinkError::PairingStorageFailed);
                    }
                    ControlMessage::Ping { nonce } => {
                        write_control(&mut send, &ControlMessage::Pong { nonce }).await?;
                    }
                    _ => return Err(LinkError::TransportProtocolError),
                }
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {
                let snapshot = {
                    let guard = state.lock().await;
                    guard.pairing.get(&pairing_id).map(|inv| {
                        (
                            inv.state.as_str(),
                            inv.device_confirmed,
                            inv.host_confirmed,
                            inv.grants.clone(),
                            inv.device_label.clone(),
                            inv.device_platform.clone(),
                        )
                    })
                };
                let Some((status, _, _, grants, label, platform)) = snapshot else {
                    write_control(&mut send, &ControlMessage::ConnectionRejected { code: "pairing-expired".into() }).await?;
                    return Err(LinkError::PairingExpired);
                };
                if status == "rejected" || status == "cancelled" || status == "expired" || status == "failed" {
                    let code = if status == "rejected" { "pairing-rejected" } else if status == "cancelled" { "pairing-cancelled" } else { "pairing-expired" };
                    write_control(&mut send, &ControlMessage::ConnectionRejected { code: code.into() }).await?;
                    return Err(LinkError::PairingInvalid);
                }
                if status == "committed" {
                    let device = {
                        let guard = state.lock().await;
                        let device = guard.trust.get(&peer).cloned();
                        if device.is_none() {
                            continue;
                        }
                        device
                    };
                    if let Some(device) = device {
                        if device.revoked {
                            write_control(&mut send, &ControlMessage::DeviceRevoked).await?;
                            return Err(LinkError::DeviceRevoked);
                        }
                        write_control(&mut send, &ControlMessage::PairingCommitted {
                            device_id: device.device_id.clone(),
                            grant_revision: device.grant_revision,
                            grants: device.grants.clone(),
                        }).await?;
                        let _ = (label, platform, grants);
                        return serve_trusted(state, connection, send, control.into_inner(), peer, device).await;
                    }
                }
            }
        }
    }
}

async fn serve_trusted(
    state: Arc<Mutex<HostState>>,
    connection: Connection,
    mut send: SendStream,
    recv: RecvStream,
    peer: String,
    device: TrustedDevice,
) -> Result<(), LinkError> {
    if device.revoked {
        write_control(
            &mut send,
            &ControlMessage::ConnectionRejected {
                code: "device-revoked".into(),
            },
        )
        .await?;
        connection.close(0u32.into(), b"revoked");
        return Err(LinkError::DeviceRevoked);
    }
    let transport = path_transport(&connection);
    let mut id = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut id);
    let connection_id = hex::encode(id);
    {
        let mut guard = state.lock().await;
        let existing: Vec<String> = guard
            .connections
            .values()
            .filter(|live| live.device_id == device.device_id)
            .map(|live| live.connection_id.clone())
            .collect();
        if existing.len() >= Limits::v1().active_connections_per_device {
            if let Some(old_id) = existing.first() {
                if let Some(old) = guard.connections.remove(old_id) {
                    old.connection.close(0u32.into(), b"replaced");
                }
            }
        }
        guard.connections.insert(
            connection_id.clone(),
            LiveConnection {
                connection_id: connection_id.clone(),
                device_id: device.device_id.clone(),
                endpoint_id: peer.clone(),
                transport,
                connection: connection.clone(),
            },
        );
        let _ = guard.events.send(json!({
            "type": "tunnel/connection-opened",
            "connectionId": connection_id,
            "deviceId": device.device_id,
            "transport": transport,
            "grantRevision": device.grant_revision,
            "grants": device.grants,
        }));
    }
    write_control(
        &mut send,
        &ControlMessage::ConnectionAccepted {
            version: PROTOCOL_VERSION,
            connection_id: connection_id.clone(),
            grant_revision: device.grant_revision,
        },
    )
    .await?;

    let http_count = Arc::new(AtomicUsize::new(0));
    let ws_count = Arc::new(AtomicUsize::new(0));
    let result = trusted_loop(
        state.clone(),
        connection.clone(),
        send,
        recv,
        connection_id.clone(),
        device.device_id.clone(),
        http_count,
        ws_count,
    )
    .await;
    {
        let mut guard = state.lock().await;
        guard.connections.remove(&connection_id);
        let _ = guard.events.send(json!({
            "type": "tunnel/connection-closed",
            "connectionId": connection_id,
            "deviceId": device.device_id,
        }));
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn trusted_loop(
    state: Arc<Mutex<HostState>>,
    connection: Connection,
    mut send: SendStream,
    recv: RecvStream,
    connection_id: String,
    device_id: String,
    http_count: Arc<AtomicUsize>,
    ws_count: Arc<AtomicUsize>,
) -> Result<(), LinkError> {
    let mut events = {
        let guard = state.lock().await;
        guard.events.subscribe()
    };
    let mut control = ControlReader::new(recv);
    loop {
        tokio::select! {
            incoming = connection.accept_bi() => {
                let (stream_send, stream_recv) = incoming.map_err(|_| LinkError::TransportProtocolError)?;
                if stream_recv.is_0rtt() {
                    return Err(LinkError::TransportProtocolError);
                }
                let state = state.clone();
                let connection_id = connection_id.clone();
                let http_count = http_count.clone();
                let ws_count = ws_count.clone();
                tokio::spawn(async move {
                    let _ = handle_data_stream(state, connection_id, stream_send, stream_recv, http_count, ws_count).await;
                });
            }
            message = control.read() => {
                match message? {
                    ControlMessage::Ping { nonce } => {
                        write_control(&mut send, &ControlMessage::Pong { nonce }).await?;
                    }
                    ControlMessage::Shutdown { .. } => break,
                    _ => return Err(LinkError::TransportProtocolError),
                }
            }
            event = events.recv() => {
                if let Ok(params) = event {
                    handle_control_event(&mut send, &device_id, params).await?;
                }
            }
            reason = connection.closed() => {
                let _ = reason;
                break;
            }
        }
    }
    Ok(())
}

async fn handle_control_event(
    send: &mut SendStream,
    device_id: &str,
    params: Value,
) -> Result<(), LinkError> {
    let event_type = params.get("type").and_then(Value::as_str).unwrap_or("");
    let event_device = params.get("deviceId").and_then(Value::as_str);
    match event_type {
        "tunnel/device-revoked" => {
            if event_device != Some(device_id) {
                return Ok(());
            }
            write_control(send, &ControlMessage::DeviceRevoked).await?;
            Err(LinkError::DeviceRevoked)
        }
        "tunnel/grants-updated" => {
            if event_device != Some(device_id) {
                return Ok(());
            }
            let revision = params
                .get("grantRevision")
                .and_then(Value::as_u64)
                .unwrap_or(0) as u32;
            write_control(
                send,
                &ControlMessage::GrantRevisionChanged {
                    grant_revision: revision,
                },
            )
            .await?;
            Ok(())
        }
        _ => Ok(()),
    }
}

async fn handle_data_stream(
    state: Arc<Mutex<HostState>>,
    connection_id: String,
    mut send: SendStream,
    mut recv: RecvStream,
    http_count: Arc<AtomicUsize>,
    ws_count: Arc<AtomicUsize>,
) -> Result<(), LinkError> {
    let kind = read_stream_kind(&mut recv).await?;
    match kind {
        STREAM_HTTP => {
            let current = http_count.fetch_add(1, Ordering::SeqCst);
            if current >= Limits::v1().concurrent_http_streams {
                http_count.fetch_sub(1, Ordering::SeqCst);
                return Err(LinkError::StreamLimitExceeded);
            }
            let result = proxy_http_stream(&state, &connection_id, &mut send, &mut recv).await;
            http_count.fetch_sub(1, Ordering::SeqCst);
            result
        }
        STREAM_WEBSOCKET => {
            let current = ws_count.fetch_add(1, Ordering::SeqCst);
            if current >= Limits::v1().concurrent_ws_streams {
                ws_count.fetch_sub(1, Ordering::SeqCst);
                return Err(LinkError::StreamLimitExceeded);
            }
            let result = proxy_ws_stream(&state, &connection_id, send, recv).await;
            ws_count.fetch_sub(1, Ordering::SeqCst);
            result
        }
        STREAM_CONTROL => Err(LinkError::TransportProtocolError),
        _ => Err(LinkError::TransportProtocolError),
    }
}

async fn proxy_http_stream(
    state: &Mutex<HostState>,
    connection_id: &str,
    send: &mut SendStream,
    recv: &mut RecvStream,
) -> Result<(), LinkError> {
    let payload = read_len_prefixed(recv, Limits::v1().http_head_bytes).await?;
    let mut framed = Vec::with_capacity(4 + payload.len());
    framed.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    framed.extend_from_slice(&payload);
    let (head, _) = decode_head::<HttpRequestHeadV1>(&framed)?;
    polyth_link_core::protocol::validate_http_request_head(&head)?;
    let path = head.path_and_query.split('?').next().unwrap_or("/");
    if !allowed_http_path(path) {
        return Err(LinkError::RequestPathDenied);
    }
    let headers = sanitize_headers(&head.headers)?;
    let priority = if path.contains("/files") || path.contains("/attachment") {
        PRI_FILE
    } else {
        PRI_API
    };
    let _ = send.set_priority(priority);

    let body_len = head.body_length.ok_or(LinkError::RequestHeaderInvalid)?;
    let (socket_path, secret) = {
        let guard = state.lock().await;
        (
            guard
                .ingress_socket
                .clone()
                .ok_or(LinkError::TransportUnavailable)?,
            guard
                .ingress_secret
                .clone()
                .ok_or(LinkError::TransportUnavailable)?,
        )
    };
    let mut unix = tokio::time::timeout(
        Duration::from_millis(Limits::v1().header_read_timeout_ms),
        UnixStream::connect(&socket_path),
    )
    .await
    .map_err(|_| LinkError::TransportUnavailable)?
    .map_err(|_| LinkError::TransportUnavailable)?;
    let mut req = format!(
        "{} {} HTTP/1.1\r\nHost: polyth.local\r\nX-Polyth-Internal-Token: {}\r\nX-Polyth-Internal-Connection: {}\r\nConnection: close\r\nContent-Length: {body_len}\r\n",
        head.method,
        head.path_and_query,
        secret,
        connection_id,
    );
    for (name, value) in headers {
        req.push_str(&format!("{name}: {value}\r\n"));
    }
    req.push_str("\r\n");
    unix.write_all(req.as_bytes())
        .await
        .map_err(|_| LinkError::TransportUnavailable)?;
    copy_exact(
        recv,
        &mut unix,
        body_len,
        if mutation_method(&head.method) {
            LinkError::TransportOutcomeUnknown
        } else {
            LinkError::TransportProtocolError
        },
    )
    .await?;
    let _ = unix.shutdown().await;
    pump_local_http_response(&mut unix, send, head.request_id, &head.method).await?;
    send.finish().map_err(|_| {
        if mutation_method(&head.method) {
            LinkError::TransportOutcomeUnknown
        } else {
            LinkError::TransportProtocolError
        }
    })?;
    Ok(())
}

async fn proxy_ws_stream(
    state: &Mutex<HostState>,
    connection_id: &str,
    mut send: SendStream,
    mut recv: RecvStream,
) -> Result<(), LinkError> {
    let payload = read_len_prefixed(&mut recv, Limits::v1().http_head_bytes).await?;
    let mut framed = Vec::with_capacity(4 + payload.len());
    framed.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    framed.extend_from_slice(&payload);
    let (open, _) = decode_head::<WebSocketOpenV1>(&framed)?;
    polyth_link_core::protocol::validate_websocket_open(&open)?;
    polyth_link_core::ws_local::validate_ws_protocols(&open.protocols)?;
    if !open.path_and_query.starts_with("/ws") {
        return Err(LinkError::RequestPathDenied);
    }
    let (socket_path, secret) = {
        let guard = state.lock().await;
        (
            guard
                .ingress_socket
                .clone()
                .ok_or(LinkError::TransportUnavailable)?,
            guard
                .ingress_secret
                .clone()
                .ok_or(LinkError::TransportUnavailable)?,
        )
    };
    let mut unix = tokio::time::timeout(
        Duration::from_millis(Limits::v1().header_read_timeout_ms),
        UnixStream::connect(&socket_path),
    )
    .await
    .map_err(|_| LinkError::TransportUnavailable)?
    .map_err(|_| LinkError::TransportUnavailable)?;
    let key = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, {
        let mut bytes = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut bytes);
        bytes
    });
    let protocol_header = if open.protocols.is_empty() {
        String::new()
    } else {
        format!("Sec-WebSocket-Protocol: {}\r\n", open.protocols.join(", "))
    };
    let req = format!(
        "GET {} HTTP/1.1\r\nHost: polyth.local\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {}\r\nX-Polyth-Internal-Token: {}\r\nX-Polyth-Internal-Connection: {}\r\n{protocol_header}\r\n",
        open.path_and_query, key, secret, connection_id
    );
    unix.write_all(req.as_bytes())
        .await
        .map_err(|_| LinkError::TransportUnavailable)?;
    let parsed = read_http_head(&mut unix, Limits::v1().http_head_bytes).await?;
    let selected = verify_upstream_switch(&parsed, &key)?;
    if selected
        .as_ref()
        .is_some_and(|protocol| !open.protocols.contains(protocol))
    {
        return Err(LinkError::Forbidden);
    }
    let accept = HttpResponseHeadV1 {
        version: PROTOCOL_VERSION,
        request_id: open.request_id,
        status: 101,
        headers: selected
            .into_iter()
            .map(|protocol| ("sec-websocket-protocol".into(), protocol))
            .collect(),
        body_length: Some(0),
    };
    write_all(&mut send, &encode_head(&accept)?).await?;
    let unix = PrefixedIo::new(parsed.leftover, unix);
    let ws = client_from_upgraded(unix).await;
    proxy_tungstenite_to_link(ws, send, recv).await
}

pub async fn close_device_connections(state: &mut HostState, device_id: &str) {
    let ids: Vec<String> = state
        .connections
        .values()
        .filter(|live| live.device_id == device_id)
        .map(|live| live.connection_id.clone())
        .collect();
    for id in ids {
        if let Some(live) = state.connections.remove(&id) {
            let _ = write_control_on(&live.connection, &ControlMessage::DeviceRevoked).await;
            live.connection.close(0u32.into(), b"revoked");
            let _ = state.events.send(json!({
                "type": "tunnel/connection-closed",
                "connectionId": id,
                "deviceId": device_id,
            }));
        }
    }
}

async fn write_control_on(
    connection: &Connection,
    message: &ControlMessage,
) -> Result<(), LinkError> {
    let (mut send, _recv) = connection
        .open_bi()
        .await
        .map_err(|_| LinkError::TransportProtocolError)?;
    let _ = send.set_priority(PRI_CONTROL);
    open_control(&mut send).await?;
    write_control(&mut send, message).await?;
    let _ = send.finish();
    Ok(())
}

#[allow(dead_code)]
pub fn _ingress_socket(path: PathBuf) -> PathBuf {
    path
}

#[allow(dead_code)]
pub fn _events_ok(events: &broadcast::Sender<Value>) -> bool {
    events.receiver_count() < 1024
}

#[allow(dead_code)]
pub fn _trust_len(map: &HashMap<String, TrustedDevice>) -> usize {
    map.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trusted_connection_hello_binds_version_and_endpoint() {
        let hello = |version, device_endpoint: &str| ControlMessage::ConnectionHello {
            version,
            device_endpoint: device_endpoint.into(),
        };
        assert!(validate_connection_hello(hello(PROTOCOL_VERSION, "peer"), "peer").is_ok());
        assert_eq!(
            validate_connection_hello(hello(PROTOCOL_VERSION + 1, "peer"), "peer"),
            Err(LinkError::TransportVersionUnsupported)
        );
        assert_eq!(
            validate_connection_hello(hello(PROTOCOL_VERSION, "other"), "peer"),
            Err(LinkError::HostIdentityMismatch)
        );
    }
}
