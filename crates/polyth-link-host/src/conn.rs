use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use iroh::endpoint::{Connection, RecvStream, SendStream};
use polyth_link_core::errors::LinkError;
use polyth_link_core::limits::Limits;
use polyth_link_core::net::path_transport;
use polyth_link_core::protocol::{
    decode_head, encode_head, encode_ws_frame, mutation_method, ControlMessage, HttpRequestHeadV1,
    HttpResponseHeadV1, WebSocketOpenV1, WsFrameType, PRI_API, PRI_CONTROL, PRI_FILE,
    STREAM_CONTROL, STREAM_HTTP, STREAM_WEBSOCKET,
};
use polyth_link_core::proxy::{allowed_http_path, sanitize_headers};
use polyth_link_core::wire::{
    copy_limited, encode_ws_client_frame, open_control, read_control, read_len_prefixed,
    read_stream_kind, write_all, write_control, ws_opcode_from_link,
};
use rand::RngCore;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
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
        return serve_trusted(state, connection, send, recv, peer, device).await;
    }

    serve_pairing(state, connection, send, recv, peer).await
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
            .map_err(|e| {
                let _ = guard.events.send(json!({
                    "type": "tunnel/pairing-proof-failed",
                    "pairingId": pairing_id,
                }));
                e
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

    loop {
        tokio::select! {
            message = read_control(&mut recv) => {
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
                        return serve_trusted(state, connection, send, recv, peer, device).await;
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
            version: 1,
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
        }));
    }
    result
}

async fn trusted_loop(
    state: Arc<Mutex<HostState>>,
    connection: Connection,
    mut send: SendStream,
    mut recv: RecvStream,
    connection_id: String,
    http_count: Arc<AtomicUsize>,
    ws_count: Arc<AtomicUsize>,
) -> Result<(), LinkError> {
    let mut events = {
        let guard = state.lock().await;
        guard.events.subscribe()
    };
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
            message = read_control(&mut recv) => {
                match message? {
                    ControlMessage::Ping { nonce } => {
                        write_control(&mut send, &ControlMessage::Pong { nonce }).await?;
                    }
                    ControlMessage::ConnectionHello { .. } => {}
                    ControlMessage::Shutdown { .. } => break,
                    _ => return Err(LinkError::TransportProtocolError),
                }
            }
            event = events.recv() => {
                if let Ok(params) = event {
                    if let Err(err) = handle_control_event(&mut send, &connection_id, params).await {
                        return Err(err);
                    }
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
    connection_id: &str,
    params: Value,
) -> Result<(), LinkError> {
    let event_type = params.get("type").and_then(Value::as_str).unwrap_or("");
    match event_type {
        "tunnel/device-revoked" => {
            write_control(send, &ControlMessage::DeviceRevoked).await?;
            Err(LinkError::DeviceRevoked)
        }
        "tunnel/grants-updated" => {
            if params.get("connectionId").and_then(Value::as_str) == Some(connection_id)
                || params.get("all").and_then(Value::as_bool) == Some(true)
            {
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
            }
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
    polyth_link_core::protocol::validate_http_path(&head.path_and_query)?;
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
    let mut unix = UnixStream::connect(&socket_path)
        .await
        .map_err(|_| LinkError::TransportUnavailable)?;
    let body_len = head.body_length.unwrap_or(0);
    if mutation_method(&head.method) && body_len > 0 {
        // Body follows on the stream. If the stream resets before we copy it,
        // callers must treat the result as transport-outcome-unknown.
    }
    let mut req = format!(
        "{} {} HTTP/1.1\r\nHost: polyth.local\r\nX-Polyth-Internal-Token: {}\r\nX-Polyth-Internal-Connection: {}\r\nConnection: close\r\n",
        head.method,
        head.path_and_query,
        secret,
        connection_id,
    );
    if head.body_length.is_some() {
        req.push_str(&format!("Content-Length: {body_len}\r\n"));
    } else {
        req.push_str("Transfer-Encoding: chunked\r\n");
    }
    for (name, value) in headers {
        req.push_str(&format!("{name}: {value}\r\n"));
    }
    req.push_str("\r\n");
    unix.write_all(req.as_bytes())
        .await
        .map_err(|_| LinkError::TransportUnavailable)?;
    if let Some(len) = head.body_length {
        copy_limited(recv, &mut unix, len)
            .await
            .map_err(|_| LinkError::TransportOutcomeUnknown)?;
    } else {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            let n = recv
                .read(&mut buf)
                .await
                .map_err(|_| LinkError::TransportOutcomeUnknown)?;
            let Some(n) = n else {
                unix.write_all(b"0\r\n\r\n")
                    .await
                    .map_err(|_| LinkError::TransportOutcomeUnknown)?;
                break;
            };
            let header = format!("{:x}\r\n", n);
            unix.write_all(header.as_bytes())
                .await
                .map_err(|_| LinkError::TransportOutcomeUnknown)?;
            unix.write_all(&buf[..n])
                .await
                .map_err(|_| LinkError::TransportOutcomeUnknown)?;
            unix.write_all(b"\r\n")
                .await
                .map_err(|_| LinkError::TransportOutcomeUnknown)?;
        }
    }
    let mut response = Vec::new();
    let mut tmp = [0u8; 16 * 1024];
    loop {
        let n = unix
            .read(&mut tmp)
            .await
            .map_err(|_| LinkError::TransportUnavailable)?;
        if n == 0 {
            break;
        }
        response.extend_from_slice(&tmp[..n]);
        if response.len() > Limits::v1().aggregate_buffered_bytes {
            return Err(LinkError::RequestTooLarge);
        }
        if let Some(header_end) = find_header_end(&response) {
            let mut headers_buf = [httparse::EMPTY_HEADER; 128];
            let mut parsed = httparse::Response::new(&mut headers_buf);
            match parsed.parse(&response) {
                Ok(httparse::Status::Complete(len)) if len <= header_end => {
                    let status = parsed.code.unwrap_or(502);
                    let mut out_headers = Vec::new();
                    for header in parsed.headers {
                        out_headers.push((
                            header.name.to_string(),
                            String::from_utf8_lossy(header.value).into_owned(),
                        ));
                    }
                    let body = response.split_off(len);
                    let head = HttpResponseHeadV1 {
                        version: 1,
                        request_id: head.request_id,
                        status,
                        headers: out_headers,
                        body_length: Some(body.len() as u64),
                    };
                    let encoded = encode_head(&head)?;
                    write_all(send, &encoded).await?;
                    write_all(send, &body).await?;
                    send.finish()
                        .map_err(|_| LinkError::TransportProtocolError)?;
                    return Ok(());
                }
                _ => {}
            }
        }
    }
    Err(LinkError::TransportProtocolError)
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| i + 4)
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
    polyth_link_core::protocol::validate_http_path(&open.path_and_query)?;
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
    let mut unix = UnixStream::connect(&socket_path)
        .await
        .map_err(|_| LinkError::TransportUnavailable)?;
    let key = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &{
        let mut bytes = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut bytes);
        bytes
    });
    let req = format!(
        "GET {} HTTP/1.1\r\nHost: polyth.local\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {}\r\nX-Polyth-Internal-Token: {}\r\nX-Polyth-Internal-Connection: {}\r\n\r\n",
        open.path_and_query, key, secret, connection_id
    );
    unix.write_all(req.as_bytes())
        .await
        .map_err(|_| LinkError::TransportUnavailable)?;
    let mut header = Vec::new();
    let mut tmp = [0u8; 1024];
    loop {
        let n = unix
            .read(&mut tmp)
            .await
            .map_err(|_| LinkError::TransportUnavailable)?;
        if n == 0 {
            return Err(LinkError::TransportProtocolError);
        }
        header.extend_from_slice(&tmp[..n]);
        if find_header_end(&header).is_some() {
            break;
        }
        if header.len() > 16 * 1024 {
            return Err(LinkError::RequestTooLarge);
        }
    }
    if !header.starts_with(b"HTTP/1.1 101") {
        return Err(LinkError::Forbidden);
    }
    let accept = HttpResponseHeadV1 {
        version: 1,
        request_id: open.request_id,
        status: 101,
        headers: vec![("upgrade".into(), "websocket".into())],
        body_length: Some(0),
    };
    write_all(&mut send, &encode_head(&accept)?).await?;

    let (mut unix_read, mut unix_write) = unix.into_split();
    proxy_ws_upgraded(&mut send, &mut recv, &mut unix_read, &mut unix_write).await
}

async fn proxy_ws_upgraded(
    send: &mut SendStream,
    recv: &mut RecvStream,
    unix_read: &mut tokio::net::unix::OwnedReadHalf,
    unix_write: &mut tokio::net::unix::OwnedWriteHalf,
) -> Result<(), LinkError> {
    loop {
        tokio::select! {
            frame = read_ws_link_frame(recv) => {
                let (kind, payload) = frame?;
                let opcode = ws_opcode_from_link(kind);
                let encoded = encode_ws_client_frame(opcode, &payload)?;
                unix_write
                    .write_all(&encoded)
                    .await
                    .map_err(|_| LinkError::TransportProtocolError)?;
                if kind == WsFrameType::Close {
                    break;
                }
            }
            frame = read_ws_server_frame(unix_read) => {
                let (kind, payload) = frame?;
                let encoded = encode_ws_frame(kind, &payload)?;
                write_all(send, &encoded).await?;
                if kind == WsFrameType::Close {
                    break;
                }
            }
        }
    }
    Ok(())
}

async fn read_ws_link_frame(recv: &mut RecvStream) -> Result<(WsFrameType, Vec<u8>), LinkError> {
    polyth_link_core::wire::read_link_ws_frame(recv).await
}

async fn read_ws_server_frame(
    read: &mut tokio::net::unix::OwnedReadHalf,
) -> Result<(WsFrameType, Vec<u8>), LinkError> {
    polyth_link_core::wire::read_rfc6455_frame(read).await
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
