use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use iroh::endpoint::{Connection, RecvStream, SendStream};
use polyth_link_core::http_io::{
    copy_exact, pump_remote_http_to_client, read_http_head, request_headers_from_parsed,
    resolve_static_path, validate_http_response_head, PrefixedIo,
};
use polyth_link_core::identity;
use polyth_link_core::limits::Limits;
use polyth_link_core::local_proxy::{
    bootstrap_redirect_target, host_allowed, origin_allowed, OwnedLoopback, ProxyBootstrap,
    BOOTSTRAP_COOKIE, BOOTSTRAP_PATH_PREFIX,
};
use polyth_link_core::net::{bind_link_endpoint, endpoint_addr_from_ticket, path_transport};
use polyth_link_core::pairing::client_proof;
use polyth_link_core::protocol::{
    decode_head, encode_head, mutation_method, ControlMessage, HttpRequestHeadV1, WebSocketOpenV1,
    PRI_API, PRI_CONTROL, STREAM_HTTP, STREAM_WEBSOCKET,
};
use polyth_link_core::ticket::{
    decode_invite_secret, parse_pairing_ticket, PairingTicket, POLYTH_LINK_ALPN,
};
use polyth_link_core::transport::TransportPolicy;
use polyth_link_core::wire::{
    open_control, read_bounded_line, read_control, write_all, write_control, write_stream_kind,
};
use polyth_link_core::ws_local::{
    accept_browser_ws, proxy_tungstenite_to_link, validate_browser_websocket,
};
use polyth_link_core::{LinkError, PROTOCOL_VERSION};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpStream, UnixListener};
use tokio::sync::{broadcast, Mutex};
use tokio::time::Duration;
use zeroize::Zeroize;

struct PairingAttempt {
    ticket: PairingTicket,
    send: SendStream,
    recv: RecvStream,
    connection: Connection,
    endpoint: iroh::Endpoint,
    started: Instant,
}

struct LiveSession {
    generation: u64,
    connection_id: String,
    host_endpoint_id: String,
    host_label: String,
    _endpoint: iroh::Endpoint,
    connection: Connection,
    proxy: ProxyHandle,
}

struct ProxyHandle {
    origin: String,
    bootstrap: String,
    boot: Arc<Mutex<ProxyBootstrap>>,
    listener: OwnedLoopback,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ExistingConnectionMode {
    Active,
    RecoverPrepared,
}

#[derive(Deserialize)]
struct RpcRequest {
    id: u64,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Serialize)]
struct RpcResponse {
    id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
}

struct ClientState {
    data_dir: PathBuf,
    metadata_lock: Arc<Mutex<()>>,
    web_dist: Option<PathBuf>,
    pairing: HashMap<String, PairingAttempt>,
    sessions: HashMap<String, LiveSession>,
    revoked_hosts: HashSet<String>,
    next_generation: u64,
    events: broadcast::Sender<Value>,
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let cmd = args.next().unwrap_or_else(|| "serve".into());
    match cmd.as_str() {
        "serve" => {
            let data_dir = args.next().unwrap_or_else(|| ".".into());
            let socket = args
                .next()
                .unwrap_or_else(|| "/tmp/polyth-link-client.sock".into());
            let web_dist = std::env::var("POLYTH_WEB_DIST").ok().map(PathBuf::from);
            if let Err(error) =
                serve(PathBuf::from(data_dir), PathBuf::from(socket), web_dist).await
            {
                eprintln!("polyth-link-client: {error}");
                std::process::exit(1);
            }
        }
        other => {
            eprintln!("unknown command {other}");
            std::process::exit(2);
        }
    }
}

fn new_state(data_dir: PathBuf, web_dist: Option<PathBuf>) -> ClientState {
    let (events, _) = broadcast::channel(128);
    ClientState {
        data_dir,
        metadata_lock: Arc::new(Mutex::new(())),
        web_dist,
        pairing: HashMap::new(),
        sessions: HashMap::new(),
        revoked_hosts: HashSet::new(),
        next_generation: 0,
        events,
    }
}

async fn serve(
    data_dir: PathBuf,
    socket: PathBuf,
    web_dist: Option<PathBuf>,
) -> Result<(), String> {
    let _ = std::fs::remove_file(&socket);
    if let Some(parent) = socket.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let listener = UnixListener::bind(&socket).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600));
    }
    let state = Arc::new(Mutex::new(new_state(data_dir, web_dist)));
    loop {
        let (stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let state = state.clone();
        tokio::spawn(async move {
            let (reader, mut writer) = stream.into_split();
            let mut reader = BufReader::new(reader);
            let mut control_buf = Vec::new();
            let mut events = state.lock().await.events.subscribe();
            loop {
                tokio::select! {
                    line = read_bounded_line(&mut reader, &mut control_buf, Limits::v1().control_message_bytes) => {
                        match line {
                            Ok(Some(line)) => {
                                let response = handle_line(state.clone(), &line).await;
                                if writer.write_all(response.as_bytes()).await.is_err() { break; }
                                if writer.write_all(b"\n").await.is_err() { break; }
                            }
                            _ => break,
                        }
                    }
                    event = events.recv() => {
                        if let Ok(params) = event {
                            let payload = json!({"method":"event","params": params});
                            if writer.write_all(payload.to_string().as_bytes()).await.is_err() { break; }
                            if writer.write_all(b"\n").await.is_err() { break; }
                        }
                    }
                }
            }
        });
    }
}

async fn handle_line(state: Arc<Mutex<ClientState>>, line: &str) -> String {
    let request: RpcRequest = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(_) => {
            return serde_json::to_string(&RpcResponse {
                id: 0,
                result: None,
                error: Some(json!({"code": LinkError::PairingInvalid.code()})),
            })
            .unwrap();
        }
    };
    let result = dispatch(state, &request.method, request.params).await;
    let response = match result {
        Ok(value) => RpcResponse {
            id: request.id,
            result: Some(value),
            error: None,
        },
        Err(code) => RpcResponse {
            id: request.id,
            result: None,
            error: Some(json!({"code": code})),
        },
    };
    serde_json::to_string(&response).unwrap()
}

async fn dispatch(
    state: Arc<Mutex<ClientState>>,
    method: &str,
    params: Value,
) -> Result<Value, &'static str> {
    match method {
        "pairing.parse" => {
            let raw = params
                .get("ticket")
                .and_then(Value::as_str)
                .ok_or(LinkError::PairingInvalid.code())?;
            let ticket = parse_pairing_ticket(raw).map_err(|error| error.code())?;
            Ok(json!({
                "hostLabel": ticket.host.label,
                "hostFingerprint": fingerprint(&ticket.host.endpoint_id),
                "expiresAt": ticket.expires_at,
            }))
        }
        "pairing.begin" => begin_pairing(state, params).await,
        "pairing.confirm" => confirm_pairing(state, params).await,
        "pairing.cancel" => {
            let id = params
                .get("attemptId")
                .and_then(Value::as_str)
                .ok_or(LinkError::PairingInvalid.code())?;
            let attempt = state.lock().await.pairing.remove(id);
            if let Some(mut attempt) = attempt {
                let _ = write_control(
                    &mut attempt.send,
                    &ControlMessage::Shutdown {
                        reason: "cancel".into(),
                    },
                )
                .await;
                attempt.connection.close(0u32.into(), b"cancel");
                attempt.endpoint.close().await;
            }
            Ok(json!({ "ok": true }))
        }
        "connections.list" => {
            let (data_dir, metadata_lock) = {
                let guard = state.lock().await;
                (guard.data_dir.clone(), guard.metadata_lock.clone())
            };
            let _metadata = metadata_lock.lock().await;
            list_metadata(&data_dir).map_err(|error| error.code())
        }
        "connect" => connect_existing(state, params, ExistingConnectionMode::Active).await,
        "disconnect" => {
            let id = params
                .get("connectionId")
                .and_then(Value::as_str)
                .ok_or(LinkError::DeviceUnknown.code())?;
            let session = state.lock().await.sessions.remove(id);
            if let Some(session) = session {
                close_session(session, b"disconnect").await;
            }
            Ok(json!({ "ok": true }))
        }
        "forget" => {
            let id = params
                .get("connectionId")
                .and_then(Value::as_str)
                .ok_or(LinkError::DeviceUnknown.code())?;
            let (session, data_dir, metadata_lock) = {
                let mut guard = state.lock().await;
                let session = guard.sessions.remove(id);
                guard.revoked_hosts.remove(id);
                (session, guard.data_dir.clone(), guard.metadata_lock.clone())
            };
            if let Some(session) = session {
                close_session(session, b"forget").await;
            }
            {
                let _metadata = metadata_lock.lock().await;
                forget_metadata(&data_dir, id).map_err(|error| error.code())?;
            }
            let _ = std::fs::remove_dir_all(data_dir.join("hosts").join(id));
            Ok(json!({ "ok": true }))
        }
        "status" => {
            let id = params
                .get("connectionId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let guard = state.lock().await;
            if guard.revoked_hosts.contains(id) {
                return Ok(json!({ "state": "revoked", "error": LinkError::DeviceRevoked.code() }));
            }
            if let Some(session) = guard.sessions.get(id) {
                Ok(json!({
                    "state": "connected",
                    "transport": path_transport(&session.connection),
                    "origin": session.proxy.origin,
                    "connectionId": session.connection_id,
                    "hostEndpointId": session.host_endpoint_id,
                    "hostLabel": session.host_label,
                }))
            } else {
                Ok(json!({ "state": "disconnected" }))
            }
        }
        _ => Err(LinkError::PairingInvalid.code()),
    }
}

async fn begin_pairing(
    state: Arc<Mutex<ClientState>>,
    params: Value,
) -> Result<Value, &'static str> {
    let raw = params
        .get("ticket")
        .and_then(Value::as_str)
        .ok_or(LinkError::PairingInvalid.code())?;
    let label = params
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or("Mobile device");
    let ticket = parse_pairing_ticket(raw).map_err(|error| error.code())?;
    let mut invite_secret = decode_invite_secret(&ticket).map_err(|error| error.code())?;
    let host_addr = endpoint_addr_from_ticket(&ticket).map_err(|error| error.code())?;
    let policy = ticket
        .candidates
        .first()
        .map(|candidate| transport_policy(&candidate.policy))
        .transpose()?
        .unwrap_or(TransportPolicy::DirectPreferred);
    let identity_path = {
        let guard = state.lock().await;
        guard
            .data_dir
            .join("hosts")
            .join(&ticket.host.endpoint_id)
            .join("identity")
    };
    let identity = identity::load_or_create(&identity_path).map_err(identity_error_code)?;
    let device_endpoint = identity.endpoint_id();
    let endpoint = bind_link_endpoint(identity.secret_key(), policy)
        .await
        .map_err(|_| LinkError::TransportUnavailable.code())?;
    let connection = tokio::time::timeout(
        Duration::from_secs(20),
        endpoint.connect(host_addr, POLYTH_LINK_ALPN.as_bytes()),
    )
    .await
    .map_err(|_| LinkError::TransportUnavailable.code())?
    .map_err(|_| LinkError::TransportUnavailable.code())?;
    if connection.remote_id().to_string() != ticket.host.endpoint_id {
        connection.close(0u32.into(), b"identity-mismatch");
        endpoint.close().await;
        return Err(LinkError::HostIdentityMismatch.code());
    }
    let (mut send, mut recv) = connection
        .open_bi()
        .await
        .map_err(|_| LinkError::TransportProtocolError.code())?;
    let _ = send.set_priority(PRI_CONTROL);
    open_control(&mut send).await.map_err(|error| error.code())?;
    let mut client_nonce = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut client_nonce);
    write_control(
        &mut send,
        &ControlMessage::PairingHello {
            pairing_id: ticket.pairing_id.clone(),
            client_nonce,
            profile: ticket.profile.clone(),
            device_label: label.chars().take(80).collect(),
            platform: std::env::consts::OS.into(),
            app_version: env!("CARGO_PKG_VERSION").into(),
        },
    )
    .await
    .map_err(|error| error.code())?;
    let server_nonce = match read_control(&mut recv).await.map_err(|error| error.code())? {
        ControlMessage::PairingChallenge { server_nonce } => server_nonce,
        ControlMessage::ConnectionRejected { code } => return Err(leak_code(code)),
        _ => return Err(LinkError::PairingInvalid.code()),
    };
    let proof = client_proof(
        &invite_secret,
        &ticket.pairing_id,
        &ticket.host.endpoint_id,
        &device_endpoint,
        &client_nonce,
        &server_nonce,
        &ticket.profile,
    );
    invite_secret.zeroize();
    write_control(&mut send, &ControlMessage::PairingProof { proof })
        .await
        .map_err(|error| error.code())?;
    let phrase = match read_control(&mut recv).await.map_err(|error| error.code())? {
        ControlMessage::PairingSafety { phrase } => phrase,
        ControlMessage::ConnectionRejected { code } => return Err(leak_code(code)),
        _ => return Err(LinkError::PairingInvalid.code()),
    };
    let mut id = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut id);
    let attempt_id = hex::encode(id);
    state.lock().await.pairing.insert(
        attempt_id.clone(),
        PairingAttempt {
            ticket,
            send,
            recv,
            connection,
            endpoint,
            started: Instant::now(),
        },
    );
    Ok(json!({
        "attemptId": attempt_id,
        "safetyPhrase": phrase,
        "state": "safety-ready",
    }))
}

async fn confirm_pairing(
    state: Arc<Mutex<ClientState>>,
    params: Value,
) -> Result<Value, &'static str> {
    let id = params
        .get("attemptId")
        .and_then(Value::as_str)
        .ok_or(LinkError::PairingInvalid.code())?;
    let mut attempt = state
        .lock()
        .await
        .pairing
        .remove(id)
        .ok_or(LinkError::PairingInvalid.code())?;
    let (data_dir, metadata_lock, web_dist) = {
        let guard = state.lock().await;
        (
            guard.data_dir.clone(),
            guard.metadata_lock.clone(),
            guard.web_dist.clone(),
        )
    };
    {
        let _metadata = metadata_lock.lock().await;
        if persist_metadata(
            &data_dir,
            &attempt.ticket.host.endpoint_id,
            attempt.ticket.host.label.as_deref().unwrap_or("Polyth"),
            attempt.ticket.candidates.first(),
            &attempt.ticket.pairing_id,
            "prepared",
            None,
        )
        .is_err()
        {
            let _ = write_control(&mut attempt.send, &ControlMessage::ClientStorageFailed).await;
            attempt.connection.close(0u32.into(), b"storage-failed");
            attempt.endpoint.close().await;
            return Err(LinkError::PairingStorageFailed.code());
        }
    }
    write_control(&mut attempt.send, &ControlMessage::PairingDeviceConfirmed)
        .await
        .map_err(|error| error.code())?;
    loop {
        if attempt.started.elapsed().as_secs() > 120 {
            attempt.connection.close(0u32.into(), b"pairing-expired");
            attempt.endpoint.close().await;
            return Err(LinkError::PairingExpired.code());
        }
        match read_control(&mut attempt.recv)
            .await
            .map_err(|error| error.code())?
        {
            ControlMessage::PairingCommitted {
                device_id,
                grant_revision: _,
                grants: _,
            } => {
                let connection_id = attempt.ticket.host.endpoint_id.clone();
                let transport = path_transport(&attempt.connection);
                {
                    let _metadata = metadata_lock.lock().await;
                    persist_metadata(
                        &data_dir,
                        &connection_id,
                        attempt.ticket.host.label.as_deref().unwrap_or("Polyth"),
                        attempt.ticket.candidates.first(),
                        &attempt.ticket.pairing_id,
                        "active",
                        Some(&device_id),
                    )
                    .and_then(|_| mark_metadata_connected(&data_dir, &connection_id, transport))
                    .map_err(|_| LinkError::PairingStorageFailed.code())?;
                }
                let proxy = start_proxy(attempt.connection.clone(), web_dist)
                    .await
                    .map_err(|_| LinkError::ProxyBootstrapInvalid.code())?;
                let origin = proxy.origin.clone();
                let bootstrap = proxy.bootstrap.clone();
                let proxy_listener = proxy.listener.clone();
                let generation;
                let previous;
                {
                    let mut guard = state.lock().await;
                    guard.revoked_hosts.remove(&connection_id);
                    generation = next_generation(&mut guard);
                    previous = guard.sessions.insert(
                        connection_id.clone(),
                        LiveSession {
                            generation,
                            connection_id: connection_id.clone(),
                            host_endpoint_id: connection_id.clone(),
                            host_label: attempt.ticket.host.label.clone().unwrap_or_default(),
                            _endpoint: attempt.endpoint,
                            connection: attempt.connection.clone(),
                            proxy,
                        },
                    );
                }
                if let Some(previous) = previous {
                    close_session(previous, b"replaced").await;
                }
                spawn_control_loop(
                    state.clone(),
                    connection_id.clone(),
                    generation,
                    attempt.send,
                    attempt.recv,
                    attempt.connection,
                    proxy_listener,
                );
                return Ok(json!({
                    "connectionId": connection_id,
                    "origin": origin,
                    "bootstrap": bootstrap,
                    "bootstrapUrl": bootstrap,
                    "deviceId": device_id,
                }));
            }
            ControlMessage::ConnectionRejected { code } => return Err(leak_code(code)),
            ControlMessage::DeviceRevoked => return Err(LinkError::DeviceRevoked.code()),
            ControlMessage::Ping { nonce } => {
                let _ = write_control(&mut attempt.send, &ControlMessage::Pong { nonce }).await;
            }
            _ => {}
        }
    }
}

async fn connect_existing(
    state: Arc<Mutex<ClientState>>,
    params: Value,
    mode: ExistingConnectionMode,
) -> Result<Value, &'static str> {
    let id = params
        .get("connectionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(LinkError::DeviceUnknown.code())?;
    let live = {
        let guard = state.lock().await;
        if guard.revoked_hosts.contains(id) {
            return Err(LinkError::DeviceRevoked.code());
        }
        guard.sessions.get(id).map(|session| {
            (
                session.proxy.origin.clone(),
                session.proxy.boot.clone(),
                session.generation,
            )
        })
    };
    if let Some((origin, boot, _generation)) = live {
        let bootstrap = {
            let mut boot = boot.lock().await;
            boot.mint_fresh_nonce();
            boot.bootstrap_url()
        };
        let mut result = json!({
            "origin": origin,
            "bootstrap": bootstrap,
            "bootstrapUrl": bootstrap,
            "connectionId": id,
        });
        if mode == ExistingConnectionMode::RecoverPrepared {
            result["state"] = Value::String("connected".into());
        }
        return Ok(result);
    }
    let (data_dir, web_dist, metadata_lock) = {
        let guard = state.lock().await;
        (
            guard.data_dir.clone(),
            guard.web_dist.clone(),
            guard.metadata_lock.clone(),
        )
    };
    let identity_path = data_dir.join("hosts").join(id).join("identity");
    let identity = identity::load_existing(&identity_path).map_err(identity_error_code)?;
    let (policy, saved_direct, saved_relays, host_label) = {
        let _metadata = metadata_lock.lock().await;
        let saved = read_metadata(&metadata_path(&data_dir)).map_err(|error| error.code())?;
        let item = saved
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
            .ok_or(LinkError::DeviceUnknown.code())?;
        if item.get("hostEndpointId").and_then(Value::as_str) != Some(id) {
            return Err(LinkError::HostIdentityMismatch.code());
        }
        if item.get("revoked").and_then(Value::as_bool) == Some(true)
            || item.get("pairingState").and_then(Value::as_str) == Some("revoked")
        {
            return Err(LinkError::DeviceRevoked.code());
        }
        match (mode, item.get("pairingState").and_then(Value::as_str)) {
            (ExistingConnectionMode::Active, Some("active"))
            | (ExistingConnectionMode::RecoverPrepared, Some("prepared")) => {}
            _ => return Err(LinkError::DeviceUnknown.code()),
        }
        let strings = |field: &str| -> Result<Vec<String>, &'static str> {
            match item.get(field) {
                None => Ok(Vec::new()),
                Some(Value::Array(values)) => values
                    .iter()
                    .map(|value| {
                        value
                            .as_str()
                            .map(str::to_string)
                            .ok_or(LinkError::PairingStorageFailed.code())
                    })
                    .collect(),
                Some(_) => Err(LinkError::PairingStorageFailed.code()),
            }
        };
        let policy = transport_policy(
            item.get("activePolicy")
                .and_then(Value::as_str)
                .unwrap_or("direct-preferred"),
        )?;
        (
            policy,
            strings("directAddresses")?,
            strings("relayUrls")?,
            item.get("hostLabel")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        )
    };
    let identity_endpoint_id = identity.endpoint_id();
    let endpoint = bind_link_endpoint(identity.secret_key(), policy)
        .await
        .map_err(|_| LinkError::TransportUnavailable.code())?;
    let host_id: iroh::EndpointId = id
        .parse()
        .map_err(|_| LinkError::HostIdentityMismatch.code())?;
    let mut addr = iroh::EndpointAddr::new(host_id);
    for item in saved_direct {
        let socket = item
            .parse()
            .map_err(|_| LinkError::PairingStorageFailed.code())?;
        addr = addr.with_ip_addr(socket);
    }
    for relay in saved_relays {
        let url = relay
            .parse::<iroh::RelayUrl>()
            .map_err(|_| LinkError::PairingStorageFailed.code())?;
        addr = addr.with_relay_url(url);
    }
    let connection = endpoint
        .connect(addr, POLYTH_LINK_ALPN.as_bytes())
        .await
        .map_err(|_| LinkError::TransportUnavailable.code())?;
    if connection.remote_id().to_string() != id {
        connection.close(0u32.into(), b"identity-mismatch");
        endpoint.close().await;
        return Err(LinkError::HostIdentityMismatch.code());
    }
    let (mut send, mut recv) = connection
        .open_bi()
        .await
        .map_err(|_| LinkError::TransportProtocolError.code())?;
    let _ = send.set_priority(PRI_CONTROL);
    open_control(&mut send).await.map_err(|error| error.code())?;
    write_control(
        &mut send,
        &ControlMessage::ConnectionHello {
            version: PROTOCOL_VERSION,
            device_endpoint: identity_endpoint_id.clone(),
        },
    )
    .await
    .map_err(|error| error.code())?;
    let response = read_control(&mut recv).await.map_err(|error| error.code())?;
    if mode == ExistingConnectionMode::RecoverPrepared && authoritative_orphan(&response) {
        connection.close(0u32.into(), b"orphaned-pairing");
        endpoint.close().await;
        return Ok(json!({
            "state": "orphaned",
            "connectionId": id,
            "identityEndpointId": identity_endpoint_id,
        }));
    }
    validate_connection_response(response)?;
    let transport = path_transport(&connection);
    {
        let _metadata = metadata_lock.lock().await;
        mark_metadata_connected(&data_dir, id, transport)
            .map_err(|_| LinkError::PairingStorageFailed.code())?;
    }
    let proxy = start_proxy(connection.clone(), web_dist)
        .await
        .map_err(|_| LinkError::ProxyBootstrapInvalid.code())?;
    let origin = proxy.origin.clone();
    let bootstrap = proxy.bootstrap.clone();
    let proxy_listener = proxy.listener.clone();
    let generation;
    let previous;
    {
        let mut guard = state.lock().await;
        if guard.revoked_hosts.contains(id) {
            proxy.listener.close();
            connection.close(0u32.into(), b"revoked");
            endpoint.close().await;
            return Err(LinkError::DeviceRevoked.code());
        }
        generation = next_generation(&mut guard);
        previous = guard.sessions.insert(
            id.to_string(),
            LiveSession {
                generation,
                connection_id: id.to_string(),
                host_endpoint_id: id.to_string(),
                host_label,
                _endpoint: endpoint,
                connection: connection.clone(),
                proxy,
            },
        );
    }
    if let Some(previous) = previous {
        close_session(previous, b"replaced").await;
    }
    spawn_control_loop(
        state.clone(),
        id.to_string(),
        generation,
        send,
        recv,
        connection,
        proxy_listener,
    );
    let mut result = json!({
        "origin": origin,
        "bootstrap": bootstrap,
        "bootstrapUrl": bootstrap,
        "connectionId": id,
    });
    if mode == ExistingConnectionMode::RecoverPrepared {
        result["state"] = Value::String("connected".into());
    }
    Ok(result)
}

fn validate_connection_response(message: ControlMessage) -> Result<(), &'static str> {
    match message {
        ControlMessage::ConnectionAccepted { version, .. } if version == PROTOCOL_VERSION => Ok(()),
        ControlMessage::ConnectionAccepted { .. } => {
            Err(LinkError::TransportVersionUnsupported.code())
        }
        ControlMessage::DeviceRevoked => Err(LinkError::DeviceRevoked.code()),
        ControlMessage::ConnectionRejected { code } => Err(leak_code(code)),
        _ => Err(LinkError::TransportProtocolError.code()),
    }
}

fn authoritative_orphan(message: &ControlMessage) -> bool {
    matches!(
        message,
        ControlMessage::ConnectionRejected { code }
            if code == "pairing-invalid" || code == "device-unknown"
    )
}

fn transport_policy(value: &str) -> Result<TransportPolicy, &'static str> {
    match value {
        "direct-preferred" | "" => Ok(TransportPolicy::DirectPreferred),
        "relay-only" => Ok(TransportPolicy::RelayOnly),
        "air-gapped" => Ok(TransportPolicy::AirGapped),
        _ => Err(LinkError::PairingInvalid.code()),
    }
}

fn identity_error_code(error: identity::IdentityError) -> &'static str {
    match error {
        identity::IdentityError::Corrupt | identity::IdentityError::UnsupportedVersion => {
            LinkError::HostIdentityCorrupt.code()
        }
        identity::IdentityError::NotFound
        | identity::IdentityError::Permission
        | identity::IdentityError::Io => LinkError::PairingStorageFailed.code(),
    }
}

fn next_generation(state: &mut ClientState) -> u64 {
    state.next_generation = state.next_generation.wrapping_add(1);
    if state.next_generation == 0 {
        state.next_generation = 1;
    }
    state.next_generation
}

async fn close_session(session: LiveSession, reason: &'static [u8]) {
    session.proxy.listener.close();
    session.connection.close(0u32.into(), reason);
    session._endpoint.close().await;
}

async fn start_proxy(
    connection: Connection,
    web_dist: Option<PathBuf>,
) -> Result<ProxyHandle, LinkError> {
    let (listener, owned) = polyth_link_core::local_proxy::bind_owned_loopback().await?;
    let port = owned.port;
    let boot = Arc::new(Mutex::new(ProxyBootstrap::new(port)));
    let bootstrap = boot.lock().await.bootstrap_url();
    let origin = format!("http://127.0.0.1:{port}");
    let mut shutdown_rx = owned.subscribe();
    let boot_handle = boot.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => break,
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { break };
                    let connection = connection.clone();
                    let web_dist = web_dist.clone();
                    let boot = boot.clone();
                    tokio::spawn(async move {
                        let _ = handle_proxy_conn(stream, connection, web_dist, boot).await;
                    });
                }
            }
        }
    });
    Ok(ProxyHandle {
        origin,
        bootstrap,
        boot: boot_handle,
        listener: owned,
    })
}

async fn handle_proxy_conn(
    mut stream: TcpStream,
    connection: Connection,
    web_dist: Option<PathBuf>,
    boot: Arc<Mutex<ProxyBootstrap>>,
) -> Result<(), LinkError> {
    let parsed = read_http_head(&mut stream, Limits::v1().http_head_bytes).await?;
    let method = parsed.method.clone().unwrap_or_else(|| "GET".into());
    let raw_path = parsed.path.clone().unwrap_or_else(|| "/".into());
    let (path, query) = split_path_query(&raw_path);
    let port = stream
        .local_addr()
        .map_err(|_| LinkError::ProxyOriginDenied)?
        .port();
    let hosts: Vec<&str> = parsed
        .headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("host"))
        .map(|(_, value)| value.as_str())
        .collect();
    if hosts.len() != 1 || !host_allowed(hosts[0], port) {
        write_http(&mut stream, 403, "invalid host").await?;
        return Err(LinkError::ProxyOriginDenied);
    }
    let origins: Vec<&str> = parsed
        .headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("origin"))
        .map(|(_, value)| value.as_str())
        .collect();
    if origins.len() > 1 || origins.first().is_some_and(|origin| !origin_allowed(origin, port)) {
        write_http(&mut stream, 403, "not allowed").await?;
        return Err(LinkError::ProxyOriginDenied);
    }
    if let Some(rest) = path.strip_prefix(BOOTSTRAP_PATH_PREFIX) {
        if rest.ends_with('/') || rest.is_empty() {
            write_http(&mut stream, 400, "invalid bootstrap").await?;
            return Err(LinkError::ProxyBootstrapInvalid);
        }
        let location = match bootstrap_redirect_target(query.as_deref()) {
            Ok(value) => value,
            Err(error) => {
                write_http(&mut stream, 400, "invalid redirect").await?;
                return Err(error);
            }
        };
        let session = match boot.lock().await.consume_nonce(rest) {
            Ok(session) => session,
            Err(error) => {
                write_http(&mut stream, 400, "invalid bootstrap").await?;
                return Err(error);
            }
        };
        let headers = format!(
            "HTTP/1.1 302 Found\r\nLocation: {location}\r\nSet-Cookie: {BOOTSTRAP_COOKIE}={session}; Path=/; HttpOnly; SameSite=Strict\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        stream
            .write_all(headers.as_bytes())
            .await
            .map_err(|_| LinkError::TransportProtocolError)?;
        return Ok(());
    }
    let cookie = parsed.header("cookie");
    let session_ok = {
        let guard = boot.lock().await;
        cookie
            .and_then(|cookie| {
                cookie.split(';').find_map(|part| {
                    part.trim()
                        .strip_prefix(&format!("{BOOTSTRAP_COOKIE}="))
                })
            })
            .map(|value| guard.session_valid(value))
            .unwrap_or(false)
    };
    if !session_ok {
        write_http(&mut stream, 401, "authentication required").await?;
        return Err(LinkError::ProxySessionInvalid);
    }
    let websocket_path = path == "/ws" || path.starts_with("/ws/");
    if path.starts_with("/api/") || websocket_path {
        if parsed.is_websocket_upgrade() || websocket_path {
            return proxy_ws(stream, parsed, &connection, &raw_path).await;
        }
        return proxy_http(stream, parsed, &connection, &method, &raw_path).await;
    }
    serve_static(&mut stream, web_dist.as_deref(), &path).await
}

fn split_path_query(raw: &str) -> (String, Option<String>) {
    match raw.split_once('?') {
        Some((path, query)) => (path.to_string(), Some(query.to_string())),
        None => (raw.to_string(), None),
    }
}

fn spawn_control_loop(
    state: Arc<Mutex<ClientState>>,
    connection_id: String,
    generation: u64,
    mut send: SendStream,
    mut recv: RecvStream,
    connection: Connection,
    proxy_listener: OwnedLoopback,
) {
    tokio::spawn(async move {
        let mut revoked = false;
        loop {
            match read_control(&mut recv).await {
                Ok(ControlMessage::Ping { nonce }) => {
                    if write_control(&mut send, &ControlMessage::Pong { nonce })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(ControlMessage::DeviceRevoked) => {
                    revoked = true;
                    break;
                }
                Ok(ControlMessage::ConnectionRejected { code }) if code == "device-revoked" => {
                    revoked = true;
                    break;
                }
                Ok(ControlMessage::Shutdown { .. }) => break,
                Ok(ControlMessage::ConnectionAccepted { .. })
                | Ok(ControlMessage::GrantRevisionChanged { .. })
                | Ok(ControlMessage::TransportStatus { .. })
                | Ok(ControlMessage::HostDescriptorUpdated { .. })
                | Ok(ControlMessage::Pong { .. }) => {}
                Ok(_) | Err(_) => break,
            }
        }
        proxy_listener.close();
        connection.close(0u32.into(), if revoked { b"revoked" } else { b"closed" });
        finish_session(state, &connection_id, generation, revoked).await;
    });
}

async fn finish_session(
    state: Arc<Mutex<ClientState>>,
    connection_id: &str,
    generation: u64,
    revoked: bool,
) {
    let (removed, data_dir, metadata_lock) = {
        let mut guard = state.lock().await;
        let current = guard
            .sessions
            .get(connection_id)
            .is_some_and(|session| session.generation == generation);
        if !current {
            return;
        }
        if revoked {
            guard.revoked_hosts.insert(connection_id.to_string());
        }
        (
            guard.sessions.remove(connection_id),
            guard.data_dir.clone(),
            guard.metadata_lock.clone(),
        )
    };
    if let Some(session) = removed {
        session.proxy.listener.close();
        session.connection.close(0u32.into(), b"closed");
    }
    if revoked {
        let _metadata = metadata_lock.lock().await;
        let _ = mark_metadata_revoked(&data_dir, connection_id);
    }
}

async fn proxy_http(
    mut stream: TcpStream,
    parsed: polyth_link_core::http_io::ParsedHttpHead,
    connection: &Connection,
    method: &str,
    path: &str,
) -> Result<(), LinkError> {
    if parsed.transfer_encoding_chunked()? {
        write_http(&mut stream, 400, "chunked requests are not forwarded").await?;
        return Err(LinkError::RequestHeaderInvalid);
    }
    let content_length = parsed.content_length()?;
    if mutation_method(method) && content_length.is_none() {
        write_http(&mut stream, 411, "content-length required").await?;
        return Err(LinkError::RequestHeaderInvalid);
    }
    let body_length = content_length.or(Some(0));
    if let Some(len) = body_length {
        if len > Limits::v1().http_body_bytes {
            write_http(&mut stream, 413, "too large").await?;
            return Err(LinkError::RequestTooLarge);
        }
    }
    let headers = request_headers_from_parsed(&parsed)?;
    let leftover = parsed.leftover;
    let (mut send, mut recv) = tokio::time::timeout(
        Duration::from_millis(Limits::v1().iroh_open_timeout_ms),
        connection.open_bi(),
    )
    .await
    .map_err(|_| LinkError::TransportUnavailable)?
    .map_err(|_| LinkError::TransportProtocolError)?;
    if recv.is_0rtt() {
        return Err(LinkError::TransportProtocolError);
    }
    let _ = send.set_priority(PRI_API);
    write_stream_kind(&mut send, STREAM_HTTP).await?;
    let mut request_id = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut request_id);
    let head = HttpRequestHeadV1 {
        version: PROTOCOL_VERSION,
        request_id,
        method: method.into(),
        path_and_query: path.into(),
        headers,
        body_length,
    };
    write_all(&mut send, &encode_head(&head)?).await?;
    let mut chained = std::io::Cursor::new(leftover).chain(&mut stream);
    if let Some(len) = body_length {
        copy_exact(
            &mut chained,
            &mut send,
            len,
            if mutation_method(method) {
                LinkError::TransportOutcomeUnknown
            } else {
                LinkError::TransportProtocolError
            },
        )
        .await?;
    }
    send.finish().map_err(|_| {
        if mutation_method(method) {
            LinkError::TransportOutcomeUnknown
        } else {
            LinkError::TransportProtocolError
        }
    })?;
    pump_remote_http_to_client(&mut recv, &mut stream, request_id, method).await
}

async fn proxy_ws(
    mut stream: TcpStream,
    parsed: polyth_link_core::http_io::ParsedHttpHead,
    connection: &Connection,
    path: &str,
) -> Result<(), LinkError> {
    let browser = match validate_browser_websocket(&parsed) {
        Ok(browser) => browser,
        Err(error) => {
            write_http(&mut stream, 400, "invalid websocket").await?;
            return Err(error);
        }
    };
    let (mut send, mut recv) = tokio::time::timeout(
        Duration::from_millis(Limits::v1().iroh_open_timeout_ms),
        connection.open_bi(),
    )
    .await
    .map_err(|_| LinkError::TransportUnavailable)?
    .map_err(|_| LinkError::TransportProtocolError)?;
    if recv.is_0rtt() {
        return Err(LinkError::TransportProtocolError);
    }
    write_stream_kind(&mut send, STREAM_WEBSOCKET).await?;
    let mut request_id = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut request_id);
    write_all(
        &mut send,
        &encode_head(&WebSocketOpenV1 {
            version: PROTOCOL_VERSION,
            request_id,
            path_and_query: path.into(),
            protocols: browser.protocols.clone(),
        })?,
    )
    .await?;
    let payload =
        polyth_link_core::wire::read_len_prefixed(&mut recv, Limits::v1().http_head_bytes).await?;
    let mut framed = Vec::with_capacity(4 + payload.len());
    framed.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    framed.extend_from_slice(&payload);
    let (response, _) = decode_head::<polyth_link_core::protocol::HttpResponseHeadV1>(&framed)?;
    validate_http_response_head(&response, &request_id)?;
    if response.status != 101 {
        write_http(&mut stream, response.status, "upgrade failed").await?;
        return Err(LinkError::Forbidden);
    }
    let selected = response
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("sec-websocket-protocol"))
        .map(|(_, value)| value.clone());
    let mut replay = parsed.header_block.clone();
    replay.extend_from_slice(&parsed.leftover);
    let prefixed = PrefixedIo::new(replay, stream);
    let ws = accept_browser_ws(prefixed, selected).await?;
    proxy_tungstenite_to_link(ws, send, recv).await
}

async fn serve_static(
    stream: &mut TcpStream,
    web_dist: Option<&Path>,
    path: &str,
) -> Result<(), LinkError> {
    let Some(root) = web_dist else {
        return write_http(stream, 404, "not found").await;
    };
    let file = match resolve_static_path(root, path) {
        Ok(file) => file,
        Err(_) => return write_http(stream, 404, "not found").await,
    };
    let bytes = tokio::fs::read(&file)
        .await
        .map_err(|_| LinkError::RequestPathDenied)?;
    let content_type = match file.extension().and_then(|extension| extension.to_str()) {
        Some("js") => "text/javascript",
        Some("css") => "text/css",
        Some("html") => "text/html; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("woff2") => "font/woff2",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    };
    let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n",
        bytes.len()
    );
    stream
        .write_all(headers.as_bytes())
        .await
        .map_err(|_| LinkError::TransportProtocolError)?;
    stream
        .write_all(&bytes)
        .await
        .map_err(|_| LinkError::TransportProtocolError)?;
    Ok(())
}

async fn write_http(stream: &mut TcpStream, status: u16, body: &str) -> Result<(), LinkError> {
    let payload = format!("{{\"error\":\"{body}\"}}");
    let reason = match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        411 => "Length Required",
        413 => "Payload Too Large",
        _ => "Error",
    };
    let headers = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        payload.len()
    );
    stream
        .write_all(headers.as_bytes())
        .await
        .map_err(|_| LinkError::TransportProtocolError)?;
    stream
        .write_all(payload.as_bytes())
        .await
        .map_err(|_| LinkError::TransportProtocolError)?;
    Ok(())
}

fn fingerprint(endpoint_id: &str) -> String {
    format!(
        "{}…{}",
        &endpoint_id[..endpoint_id.len().min(4)],
        &endpoint_id[endpoint_id.len().saturating_sub(4)..]
    )
}

fn metadata_path(data_dir: &Path) -> PathBuf {
    data_dir.join("connections.json")
}

fn list_metadata(data_dir: &Path) -> Result<Value, LinkError> {
    let list = read_metadata(&metadata_path(data_dir))?;
    Ok(json!(
        list.into_iter()
            .filter(|item| item.get("pairingState").and_then(Value::as_str) != Some("prepared"))
            .map(|item| {
                json!({
                    "id": item.get("id").cloned().unwrap_or(Value::Null),
                    "hostEndpointId": item.get("hostEndpointId").cloned().unwrap_or(Value::Null),
                    "hostLabel": item.get("hostLabel").cloned().unwrap_or(Value::String(String::new())),
                    "lastUsedAt": item.get("lastUsedAt").cloned().unwrap_or(Value::from(0)),
                    "lastTransport": item.get("lastTransport").cloned().unwrap_or(Value::Null),
                    "revoked": item.get("revoked").cloned().unwrap_or(Value::Bool(false)),
                    "hasSecureIdentity": item.get("hasSecureIdentity").cloned().unwrap_or(Value::Bool(false)),
                })
            })
            .collect::<Vec<_>>()
    ))
}

fn read_metadata(path: &Path) -> Result<Vec<Value>, LinkError> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|_| LinkError::PairingStorageFailed),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(_) => Err(LinkError::PairingStorageFailed),
    }
}

fn write_metadata(path: &Path, list: &[Value]) -> Result<(), LinkError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| LinkError::PairingStorageFailed)?;
    }
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec(list).map_err(|_| LinkError::PairingStorageFailed)?;
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&tmp)
        .map_err(|_| LinkError::PairingStorageFailed)?;
    std::io::Write::write_all(&mut file, &bytes).map_err(|_| LinkError::PairingStorageFailed)?;
    file.sync_all()
        .map_err(|_| LinkError::PairingStorageFailed)?;
    std::fs::rename(&tmp, path).map_err(|_| LinkError::PairingStorageFailed)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| LinkError::PairingStorageFailed)?;
        if let Some(parent) = path.parent() {
            std::fs::File::open(parent)
                .and_then(|dir| dir.sync_all())
                .map_err(|_| LinkError::PairingStorageFailed)?;
        }
    }
    Ok(())
}

fn persist_metadata(
    data_dir: &Path,
    host_endpoint_id: &str,
    label: &str,
    candidate: Option<&polyth_link_core::ticket::PairingCandidate>,
    pairing_id: &str,
    pairing_state: &str,
    device_id: Option<&str>,
) -> Result<(), LinkError> {
    let path = metadata_path(data_dir);
    let mut list = read_metadata(&path)?;
    list.retain(|item| {
        item.get("hostEndpointId").and_then(Value::as_str) != Some(host_endpoint_id)
    });
    list.insert(
        0,
        json!({
            "id": host_endpoint_id,
            "hostEndpointId": host_endpoint_id,
            "hostLabel": label,
            "pairingId": pairing_id,
            "pairingState": pairing_state,
            "deviceId": device_id,
            "lastUsedAt": now_ms(),
            "lastTransport": Value::Null,
            "revoked": false,
            "hasSecureIdentity": true,
            "activePolicy": candidate.map(|item| item.policy.clone()).unwrap_or_else(|| "direct-preferred".into()),
            "directAddresses": candidate.and_then(|item| item.direct_addresses.clone()).unwrap_or_default(),
            "relayUrls": candidate.map(|item| item.relay_urls.clone()).unwrap_or_default(),
        }),
    );
    write_metadata(&path, &list)
}

fn mark_metadata_connected(
    data_dir: &Path,
    host_endpoint_id: &str,
    transport: &str,
) -> Result<(), LinkError> {
    let path = metadata_path(data_dir);
    let mut list = read_metadata(&path)?;
    let item = list
        .iter_mut()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(host_endpoint_id))
        .ok_or(LinkError::DeviceUnknown)?;
    let object = item
        .as_object_mut()
        .ok_or(LinkError::PairingStorageFailed)?;
    object.insert("pairingState".into(), Value::String("active".into()));
    object.insert("lastUsedAt".into(), Value::from(now_ms()));
    object.insert("lastTransport".into(), Value::String(transport.into()));
    object.insert("revoked".into(), Value::Bool(false));
    write_metadata(&path, &list)
}

fn mark_metadata_revoked(
    data_dir: &Path,
    host_endpoint_id: &str,
) -> Result<(), LinkError> {
    let path = metadata_path(data_dir);
    let mut list = read_metadata(&path)?;
    let item = list
        .iter_mut()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(host_endpoint_id))
        .ok_or(LinkError::DeviceUnknown)?;
    let object = item
        .as_object_mut()
        .ok_or(LinkError::PairingStorageFailed)?;
    object.insert("pairingState".into(), Value::String("revoked".into()));
    object.insert("lastUsedAt".into(), Value::from(now_ms()));
    object.insert("revoked".into(), Value::Bool(true));
    write_metadata(&path, &list)
}

fn forget_metadata(data_dir: &Path, host_endpoint_id: &str) -> Result<(), LinkError> {
    let path = metadata_path(data_dir);
    let mut list = read_metadata(&path)?;
    list.retain(|item| item.get("id").and_then(Value::as_str) != Some(host_endpoint_id));
    write_metadata(&path, &list)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn leak_code(code: String) -> &'static str {
    match code.as_str() {
        "pairing-invalid" => LinkError::PairingInvalid.code(),
        "pairing-expired" => LinkError::PairingExpired.code(),
        "pairing-claimed" => LinkError::PairingClaimed.code(),
        "pairing-rejected" => LinkError::PairingRejected.code(),
        "pairing-cancelled" => LinkError::PairingCancelled.code(),
        "device-unknown" => LinkError::DeviceUnknown.code(),
        "device-revoked" => LinkError::DeviceRevoked.code(),
        "host-identity-mismatch" => LinkError::HostIdentityMismatch.code(),
        "transport-version-unsupported" => LinkError::TransportVersionUnsupported.code(),
        _ => LinkError::PairingInvalid.code(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn only_exact_host_rejections_are_authoritative_orphan_evidence() {
        for code in ["pairing-invalid", "device-unknown"] {
            assert!(authoritative_orphan(&ControlMessage::ConnectionRejected {
                code: code.into(),
            }));
        }
        assert!(!authoritative_orphan(&ControlMessage::ConnectionRejected {
            code: "unknown".into(),
        }));
        assert!(!authoritative_orphan(&ControlMessage::DeviceRevoked));
    }

    #[test]
    fn reconnect_metadata_can_be_durably_prepared_before_confirmation() {
        let dir = tempdir().unwrap();
        persist_metadata(
            dir.path(),
            "host-endpoint",
            "Polyth",
            None,
            "pairing-id",
            "prepared",
            None,
        )
        .unwrap();
        let saved = read_metadata(&metadata_path(dir.path())).unwrap();
        let item = &saved[0];
        assert_eq!(item["pairingId"], "pairing-id");
        assert_eq!(item["pairingState"], "prepared");
        assert_eq!(item["hostEndpointId"], "host-endpoint");
    }

    #[test]
    fn public_connection_list_does_not_leak_pairing_material() {
        let dir = tempdir().unwrap();
        persist_metadata(
            dir.path(),
            "host-endpoint",
            "Polyth",
            None,
            "pairing-secret-reference",
            "active",
            Some("device-id"),
        )
        .unwrap();
        let public = list_metadata(dir.path()).unwrap().to_string();
        assert!(!public.contains("pairing-secret-reference"));
        assert!(!public.contains("device-id"));
        assert!(!public.contains("directAddresses"));
        assert!(!public.contains("relayUrls"));
    }

    #[test]
    fn malformed_metadata_is_never_replaced() {
        let dir = tempdir().unwrap();
        let path = metadata_path(dir.path());
        std::fs::write(&path, b"not json").unwrap();
        assert_eq!(
            persist_metadata(
                dir.path(),
                "host-endpoint",
                "Polyth",
                None,
                "pairing-id",
                "prepared",
                None,
            ),
            Err(LinkError::PairingStorageFailed)
        );
        assert_eq!(std::fs::read(path).unwrap(), b"not json");
    }

    #[test]
    fn revocation_is_durable_and_public() {
        let dir = tempdir().unwrap();
        persist_metadata(
            dir.path(),
            "host-endpoint",
            "Polyth",
            None,
            "pairing-id",
            "active",
            Some("device-id"),
        )
        .unwrap();
        mark_metadata_revoked(dir.path(), "host-endpoint").unwrap();
        let raw = read_metadata(&metadata_path(dir.path())).unwrap();
        assert_eq!(raw[0]["pairingState"], "revoked");
        assert_eq!(raw[0]["revoked"], true);
        let public = list_metadata(dir.path()).unwrap();
        assert_eq!(public[0]["revoked"], true);
    }

    #[test]
    fn all_supported_transport_policies_restore_exactly() {
        assert_eq!(
            transport_policy("direct-preferred").unwrap(),
            TransportPolicy::DirectPreferred
        );
        assert_eq!(
            transport_policy("relay-only").unwrap(),
            TransportPolicy::RelayOnly
        );
        assert_eq!(
            transport_policy("air-gapped").unwrap(),
            TransportPolicy::AirGapped
        );
        assert!(transport_policy("anything-else").is_err());
    }

    #[test]
    fn connection_acceptance_requires_the_current_protocol() {
        let accepted = |version| ControlMessage::ConnectionAccepted {
            version,
            connection_id: "connection".into(),
            grant_revision: 1,
        };
        assert!(validate_connection_response(accepted(PROTOCOL_VERSION)).is_ok());
        assert_eq!(
            validate_connection_response(accepted(PROTOCOL_VERSION + 1)),
            Err(LinkError::TransportVersionUnsupported.code())
        );
    }
}
