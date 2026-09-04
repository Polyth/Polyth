use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use iroh::endpoint::{Connection, RecvStream, SendStream};
use polyth_link_core::http_io::{
    copy_exact, pump_remote_http_to_client, read_http_head, request_headers_from_parsed,
    resolve_static_path, PrefixedIo,
};
use polyth_link_core::identity::{self, HostIdentity};
use polyth_link_core::limits::Limits;
use polyth_link_core::local_proxy::{
    origin_allowed, validate_redirect_target, OwnedLoopback, ProxyBootstrap, BOOTSTRAP_COOKIE,
    BOOTSTRAP_PATH_PREFIX,
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
    open_control, read_control, write_all, write_control, write_stream_kind,
};
use polyth_link_core::ws_local::{
    accept_browser_ws, proxy_tungstenite_to_link, validate_browser_websocket,
};
use polyth_link_core::LinkError;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpStream, UnixListener};
use tokio::sync::{broadcast, Mutex};
use tokio::time::Duration;

#[allow(dead_code)]
struct PairingAttempt {
    id: String,
    ticket: PairingTicket,
    secret: [u8; 32],
    phrase: [String; 4],
    send: SendStream,
    recv: RecvStream,
    connection: Connection,
    identity: HostIdentity,
    started: Instant,
}

struct LiveSession {
    connection_id: String,
    host_endpoint_id: String,
    host_label: String,
    connection: Connection,
    proxy: Option<ProxyHandle>,
}

struct ProxyHandle {
    origin: String,
    bootstrap: String,
    boot: Arc<Mutex<ProxyBootstrap>>,
    listener: OwnedLoopback,
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
    web_dist: Option<PathBuf>,
    endpoint: Option<iroh::Endpoint>,
    pairing: HashMap<String, PairingAttempt>,
    sessions: HashMap<String, LiveSession>,
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
    let (events, _) = broadcast::channel(128);
    let state = Arc::new(Mutex::new(ClientState {
        data_dir,
        web_dist,
        endpoint: None,
        pairing: HashMap::new(),
        sessions: HashMap::new(),
        events,
    }));
    loop {
        let (stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let state = state.clone();
        tokio::spawn(async move {
            let (reader, mut writer) = stream.into_split();
            let mut lines = BufReader::new(reader).lines();
            let mut events = state.lock().await.events.subscribe();
            loop {
                tokio::select! {
                    line = lines.next_line() => {
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
                error: Some(json!({"code": "pairing-invalid"})),
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
                .ok_or("pairing-invalid")?;
            let ticket = parse_pairing_ticket(raw).map_err(|e| e.code())?;
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
                .ok_or("pairing-invalid")?;
            let mut guard = state.lock().await;
            if let Some(mut attempt) = guard.pairing.remove(id) {
                let _ = write_control(
                    &mut attempt.send,
                    &ControlMessage::Shutdown {
                        reason: "cancel".into(),
                    },
                )
                .await;
                attempt.connection.close(0u32.into(), b"cancel");
            }
            Ok(json!({ "ok": true }))
        }
        "connections.list" => {
            let guard = state.lock().await;
            Ok(json!(list_metadata(&guard.data_dir)))
        }
        "connect" => connect_existing(state, params).await,
        "disconnect" => {
            let id = params
                .get("connectionId")
                .and_then(Value::as_str)
                .ok_or("device-unknown")?;
            let mut guard = state.lock().await;
            if let Some(session) = guard.sessions.remove(id) {
                session.connection.close(0u32.into(), b"disconnect");
                if let Some(proxy) = session.proxy {
                    proxy.listener.close();
                }
            }
            Ok(json!({ "ok": true }))
        }
        "forget" => {
            let id = params
                .get("connectionId")
                .and_then(Value::as_str)
                .ok_or("device-unknown")?;
            let mut guard = state.lock().await;
            if let Some(session) = guard.sessions.remove(id) {
                session.connection.close(0u32.into(), b"forget");
                if let Some(proxy) = session.proxy {
                    proxy.listener.close();
                }
            }
            forget_metadata(&guard.data_dir, id);
            let dir = guard.data_dir.join("hosts").join(id);
            let _ = std::fs::remove_dir_all(dir);
            Ok(json!({ "ok": true }))
        }
        "status" => {
            let id = params
                .get("connectionId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let guard = state.lock().await;
            if let Some(session) = guard.sessions.get(id) {
                Ok(json!({
                    "state": "connected",
                    "transport": path_transport(&session.connection),
                    "origin": session.proxy.as_ref().map(|p| p.origin.clone()),
                    "connectionId": session.connection_id,
                    "hostEndpointId": session.host_endpoint_id,
                    "hostLabel": session.host_label,
                }))
            } else {
                Ok(json!({ "state": "disconnected" }))
            }
        }
        _ => Err("pairing-invalid"),
    }
}

async fn begin_pairing(
    state: Arc<Mutex<ClientState>>,
    params: Value,
) -> Result<Value, &'static str> {
    let raw = params
        .get("ticket")
        .and_then(Value::as_str)
        .ok_or("pairing-invalid")?;
    let label = params
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or("Mobile device");
    let ticket = parse_pairing_ticket(raw).map_err(|e| e.code())?;
    let secret = decode_invite_secret(&ticket).map_err(|e| e.code())?;
    let host_addr = endpoint_addr_from_ticket(&ticket).map_err(|e| e.code())?;
    let policy = match ticket.candidates.first().map(|c| c.policy.as_str()) {
        Some("relay-only") => TransportPolicy::RelayOnly,
        Some("air-gapped") => TransportPolicy::AirGapped,
        _ => TransportPolicy::DirectPreferred,
    };
    let identity_path = {
        let guard = state.lock().await;
        guard
            .data_dir
            .join("hosts")
            .join(&ticket.host.endpoint_id)
            .join("identity")
    };
    let identity =
        identity::load_or_create(&identity_path).map_err(|_| "pairing-storage-failed")?;
    let device_endpoint = identity.endpoint_id();
    let endpoint = bind_link_endpoint(identity.secret_key(), policy)
        .await
        .map_err(|_| "transport-unavailable")?;
    let connection = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        endpoint.connect(host_addr, POLYTH_LINK_ALPN.as_bytes()),
    )
    .await
    .map_err(|_| "transport-unavailable")?
    .map_err(|_| "host-identity-mismatch")?;
    if connection.remote_id().to_string() != ticket.host.endpoint_id {
        connection.close(0u32.into(), b"mismatch");
        return Err("host-identity-mismatch");
    }
    let (mut send, mut recv) = connection
        .open_bi()
        .await
        .map_err(|_| "transport-protocol-error")?;
    let _ = send.set_priority(PRI_CONTROL);
    open_control(&mut send).await.map_err(|e| e.code())?;
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
            app_version: "0.1.0".into(),
        },
    )
    .await
    .map_err(|e| e.code())?;
    let server_nonce = match read_control(&mut recv).await.map_err(|e| e.code())? {
        ControlMessage::PairingChallenge { server_nonce } => server_nonce,
        ControlMessage::ConnectionRejected { code } => return Err(leak_code(code)),
        _ => return Err("pairing-invalid"),
    };
    let proof = client_proof(
        &secret,
        &ticket.pairing_id,
        &ticket.host.endpoint_id,
        &device_endpoint,
        &client_nonce,
        &server_nonce,
        &ticket.profile,
    );
    write_control(&mut send, &ControlMessage::PairingProof { proof })
        .await
        .map_err(|e| e.code())?;
    let phrase = match read_control(&mut recv).await.map_err(|e| e.code())? {
        ControlMessage::PairingSafety { phrase } => phrase,
        ControlMessage::ConnectionRejected { code } => return Err(leak_code(code)),
        _ => return Err("pairing-invalid"),
    };
    let mut id = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut id);
    let attempt_id = hex::encode(id);
    {
        let mut guard = state.lock().await;
        guard.endpoint = Some(endpoint);
        guard.pairing.insert(
            attempt_id.clone(),
            PairingAttempt {
                id: attempt_id.clone(),
                ticket,
                secret,
                phrase: phrase.clone(),
                send,
                recv,
                connection,
                identity,
                started: Instant::now(),
            },
        );
    }
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
        .ok_or("pairing-invalid")?;
    let mut attempt = {
        let mut guard = state.lock().await;
        guard.pairing.remove(id).ok_or("pairing-invalid")?
    };
    write_control(&mut attempt.send, &ControlMessage::PairingDeviceConfirmed)
        .await
        .map_err(|e| e.code())?;
    loop {
        if attempt.started.elapsed().as_secs() > 120 {
            return Err("pairing-expired");
        }
        match read_control(&mut attempt.recv)
            .await
            .map_err(|e| e.code())?
        {
            ControlMessage::PairingCommitted {
                device_id,
                grant_revision: _,
                grants: _,
            } => {
                let data_dir = state.lock().await.data_dir.clone();
                if persist_metadata(
                    &data_dir,
                    &attempt.ticket.host.endpoint_id,
                    attempt.ticket.host.label.as_deref().unwrap_or("Polyth"),
                    attempt.ticket.candidates.first(),
                )
                .is_err()
                {
                    let _ = write_control(&mut attempt.send, &ControlMessage::ClientStorageFailed)
                        .await;
                    return Err("pairing-storage-failed");
                }
                let _ = device_id;
                spawn_control_loop(attempt.send, attempt.recv, attempt.connection.clone());
                let connection_id = attempt.ticket.host.endpoint_id.clone();
                let web_dist = state.lock().await.web_dist.clone();
                let proxy =
                    start_proxy(attempt.connection.clone(), web_dist, connection_id.clone())
                        .await
                        .map_err(|_| "proxy-bootstrap-invalid")?;
                let origin = proxy.origin.clone();
                let bootstrap = proxy.bootstrap.clone();
                {
                    let mut guard = state.lock().await;
                    guard.sessions.insert(
                        connection_id.clone(),
                        LiveSession {
                            connection_id: connection_id.clone(),
                            host_endpoint_id: attempt.ticket.host.endpoint_id.clone(),
                            host_label: attempt.ticket.host.label.clone().unwrap_or_default(),
                            connection: attempt.connection,
                            proxy: Some(proxy),
                        },
                    );
                }
                return Ok(json!({
                    "connectionId": connection_id,
                    "origin": origin,
                    "bootstrap": bootstrap,
                    "bootstrapUrl": bootstrap,
                    "deviceId": device_id,
                }));
            }
            ControlMessage::ConnectionRejected { code } => return Err(leak_code(code)),
            ControlMessage::DeviceRevoked => return Err("device-revoked"),
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
) -> Result<Value, &'static str> {
    let id = params
        .get("connectionId")
        .and_then(Value::as_str)
        .ok_or("device-unknown")?;
    let live = {
        let guard = state.lock().await;
        guard.sessions.get(id).and_then(|session| {
            session
                .proxy
                .as_ref()
                .map(|proxy| (proxy.origin.clone(), proxy.boot.clone()))
        })
    };
    if let Some((origin, boot)) = live {
        let bootstrap = {
            let mut boot = boot.lock().await;
            boot.mint_fresh_nonce();
            boot.bootstrap_url()
        };
        return Ok(json!({
            "origin": origin,
            "bootstrap": bootstrap,
            "bootstrapUrl": bootstrap,
            "connectionId": id
        }));
    }
    let (data_dir, web_dist) = {
        let guard = state.lock().await;
        (guard.data_dir.clone(), guard.web_dist.clone())
    };
    let identity_path = data_dir.join("hosts").join(id).join("identity");
    let identity = identity::load_existing(&identity_path).map_err(|_| "pairing-storage-failed")?;
    let saved_policy = current_saved_policy(&data_dir, id);
    if saved_policy != "direct-preferred" && !saved_policy.is_empty() {
        return Err("pairing-invalid");
    }
    let endpoint = bind_link_endpoint(identity.secret_key(), TransportPolicy::DirectPreferred)
        .await
        .map_err(|_| "transport-unavailable")?;
    let host_id: iroh::EndpointId = id.parse().map_err(|_| "host-identity-mismatch")?;
    let mut addr = iroh::EndpointAddr::new(host_id);
    for item in current_saved_direct(&data_dir, id) {
        if let Ok(socket) = item.parse() {
            addr = addr.with_ip_addr(socket);
        }
    }
    for relay in current_saved_relays(&data_dir, id) {
        if let Ok(url) = relay.parse::<iroh::RelayUrl>() {
            addr = addr.with_relay_url(url);
        }
    }
    let connection = endpoint
        .connect(addr, POLYTH_LINK_ALPN.as_bytes())
        .await
        .map_err(|_| "host-identity-mismatch")?;
    if connection.remote_id().to_string() != id {
        connection.close(0u32.into(), b"mismatch");
        return Err("host-identity-mismatch");
    }
    let (mut send, mut recv) = connection
        .open_bi()
        .await
        .map_err(|_| "transport-protocol-error")?;
    let _ = send.set_priority(PRI_CONTROL);
    open_control(&mut send).await.map_err(|e| e.code())?;
    write_control(
        &mut send,
        &ControlMessage::ConnectionHello {
            version: 1,
            device_endpoint: identity.endpoint_id(),
        },
    )
    .await
    .map_err(|e| e.code())?;
    match read_control(&mut recv).await.map_err(|e| e.code())? {
        ControlMessage::ConnectionAccepted {
            connection_id: _, ..
        } => {}
        ControlMessage::DeviceRevoked | ControlMessage::ConnectionRejected { .. } => {
            return Err("device-revoked")
        }
        _ => return Err("transport-protocol-error"),
    }
    spawn_control_loop(send, recv, connection.clone());
    let proxy = start_proxy(connection.clone(), web_dist, id.to_string())
        .await
        .map_err(|_| "proxy-bootstrap-invalid")?;
    let origin = proxy.origin.clone();
    let bootstrap = proxy.bootstrap.clone();
    {
        let mut guard = state.lock().await;
        guard.endpoint = Some(endpoint);
        guard.sessions.insert(
            id.to_string(),
            LiveSession {
                connection_id: id.to_string(),
                host_endpoint_id: id.to_string(),
                host_label: String::new(),
                connection,
                proxy: Some(proxy),
            },
        );
    }
    Ok(json!({
        "origin": origin,
        "bootstrap": bootstrap,
        "bootstrapUrl": bootstrap,
        "connectionId": id
    }))
}

async fn start_proxy(
    connection: Connection,
    web_dist: Option<PathBuf>,
    connection_id: String,
) -> Result<ProxyHandle, LinkError> {
    let (listener, owned) = polyth_link_core::local_proxy::bind_owned_loopback().await?;
    let port = owned.port;
    let boot = Arc::new(Mutex::new(ProxyBootstrap::new(port)));
    let bootstrap = {
        let guard = boot.lock().await;
        guard.bootstrap_url()
    };
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
                    let connection_id = connection_id.clone();
                    tokio::spawn(async move {
                        let _ = handle_proxy_conn(stream, connection, web_dist, boot, connection_id).await;
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
    _connection_id: String,
) -> Result<(), LinkError> {
    let parsed = read_http_head(&mut stream, Limits::v1().http_head_bytes).await?;
    let method = parsed.method.clone().unwrap_or_else(|| "GET".into());
    let raw_path = parsed.path.clone().unwrap_or_else(|| "/".into());
    let (path, query) = split_path_query(&raw_path);
    let origin = parsed.header("origin").map(str::to_string);
    let cookie = parsed.header("cookie").map(str::to_string);
    let port = stream.local_addr().map(|addr| addr.port()).unwrap_or(0);
    if let Some(origin) = &origin {
        if !origin_allowed(origin, port) {
            write_http(&mut stream, 403, "not allowed").await?;
            return Err(LinkError::ProxyOriginDenied);
        }
    }
    if let Some(rest) = path.strip_prefix(BOOTSTRAP_PATH_PREFIX) {
        if rest.ends_with('/') || rest.is_empty() {
            write_http(&mut stream, 400, "invalid bootstrap").await?;
            return Err(LinkError::ProxyBootstrapInvalid);
        }
        let nonce = rest.split('?').next().unwrap_or(rest);
        let next = query
            .as_deref()
            .and_then(|query| {
                query
                    .split('&')
                    .find_map(|part| part.strip_prefix("next=").map(|value| value.to_string()))
            })
            .unwrap_or_else(|| "/".into());
        let location = match validate_redirect_target(&next) {
            Ok(value) => value,
            Err(error) => {
                write_http(&mut stream, 400, "invalid redirect").await?;
                return Err(error);
            }
        };
        let session = match boot.lock().await.consume_nonce(nonce) {
            Ok(session) => session,
            Err(error) => {
                write_http(&mut stream, 400, "invalid bootstrap").await?;
                return Err(error);
            }
        };
        let headers = format!(
            "HTTP/1.1 302 Found\r\nLocation: {location}\r\nSet-Cookie: {BOOTSTRAP_COOKIE}={session}; Path=/; HttpOnly; SameSite=Strict\r\nContent-Length: 0\r\n\r\n"
        );
        stream
            .write_all(headers.as_bytes())
            .await
            .map_err(|_| LinkError::TransportProtocolError)?;
        return Ok(());
    }
    let session_ok = {
        let guard = boot.lock().await;
        cookie
            .as_deref()
            .and_then(|cookie| {
                cookie.split(';').find_map(|part| {
                    let part = part.trim();
                    part.strip_prefix(&format!("{BOOTSTRAP_COOKIE}="))
                })
            })
            .map(|value| guard.session_valid(value))
            .unwrap_or(false)
    };
    if !session_ok {
        write_http(&mut stream, 401, "authentication required").await?;
        return Err(LinkError::ProxySessionInvalid);
    }
    if path.starts_with("/api/") || path.starts_with("/ws") {
        if parsed.is_websocket_upgrade() || path.starts_with("/ws") {
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

fn spawn_control_loop(mut send: SendStream, mut recv: RecvStream, connection: Connection) {
    tokio::spawn(async move {
        loop {
            match read_control(&mut recv).await {
                Ok(ControlMessage::Ping { nonce }) => {
                    let _ = write_control(&mut send, &ControlMessage::Pong { nonce }).await;
                }
                Ok(ControlMessage::DeviceRevoked) | Ok(ControlMessage::Shutdown { .. }) => {
                    connection.close(0u32.into(), b"revoked");
                    break;
                }
                Ok(ControlMessage::ConnectionAccepted { .. })
                | Ok(ControlMessage::GrantRevisionChanged { .. })
                | Ok(ControlMessage::TransportStatus { .. })
                | Ok(ControlMessage::HostDescriptorUpdated { .. })
                | Ok(ControlMessage::Pong { .. }) => {}
                Ok(_) | Err(_) => break,
            }
        }
    });
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
        version: 1,
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
            version: 1,
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
    if response.status != 101 {
        write_http(&mut stream, response.status, "upgrade failed").await?;
        return Err(LinkError::Forbidden);
    }
    let selected = response
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("sec-websocket-protocol"))
        .map(|(_, value)| value.clone())
        .or_else(|| browser.protocols.first().cloned());
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
    let content_type = match file.extension().and_then(|e| e.to_str()) {
        Some("js") => "text/javascript",
        Some("css") => "text/css",
        Some("html") => "text/html; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    };
    let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-cache\r\n\r\n",
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
    let headers = format!(
        "HTTP/1.1 {status} \r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
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

fn list_metadata(data_dir: &Path) -> Value {
    let path = metadata_path(data_dir);
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| json!([]))
}

fn persist_metadata(
    data_dir: &Path,
    host_endpoint_id: &str,
    label: &str,
    candidate: Option<&polyth_link_core::ticket::PairingCandidate>,
) -> Result<(), LinkError> {
    let path = metadata_path(data_dir);
    let mut list: Vec<Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    list.retain(|item| {
        item.get("hostEndpointId").and_then(Value::as_str) != Some(host_endpoint_id)
    });
    list.insert(
        0,
        json!({
            "id": host_endpoint_id,
            "hostEndpointId": host_endpoint_id,
            "hostLabel": label,
            "lastUsedAt": now_ms(),
            "hasSecureIdentity": true,
            "activePolicy": candidate.map(|item| item.policy.clone()).unwrap_or_else(|| "direct-preferred".into()),
            "directAddresses": candidate.and_then(|item| item.direct_addresses.clone()).unwrap_or_default(),
            "relayUrls": candidate.map(|item| item.relay_urls.clone()).unwrap_or_default(),
        }),
    );
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| LinkError::PairingStorageFailed)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(
        &tmp,
        serde_json::to_vec(&list).map_err(|_| LinkError::PairingStorageFailed)?,
    )
    .map_err(|_| LinkError::PairingStorageFailed)?;
    std::fs::rename(tmp, path).map_err(|_| LinkError::PairingStorageFailed)?;
    Ok(())
}

fn forget_metadata(data_dir: &Path, host_endpoint_id: &str) {
    let path = metadata_path(data_dir);
    let mut list: Vec<Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    list.retain(|item| item.get("id").and_then(Value::as_str) != Some(host_endpoint_id));
    let _ = std::fs::write(path, serde_json::to_vec(&list).unwrap_or_default());
}

fn current_saved_direct(data_dir: &Path, id: &str) -> Vec<String> {
    saved_string_list(data_dir, id, "directAddresses")
}

fn current_saved_relays(data_dir: &Path, id: &str) -> Vec<String> {
    saved_string_list(data_dir, id, "relayUrls")
}

fn current_saved_policy(data_dir: &Path, id: &str) -> String {
    let list = list_metadata(data_dir);
    list.as_array()
        .into_iter()
        .flatten()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
        .and_then(|item| item.get("activePolicy").and_then(Value::as_str))
        .unwrap_or("direct-preferred")
        .to_string()
}

fn saved_string_list(data_dir: &Path, id: &str, field: &str) -> Vec<String> {
    let list = list_metadata(data_dir);
    list.as_array()
        .into_iter()
        .flatten()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
        .and_then(|item| item.get(field).and_then(Value::as_array).cloned())
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn leak_code(code: String) -> &'static str {
    match code.as_str() {
        "pairing-invalid" => "pairing-invalid",
        "pairing-expired" => "pairing-expired",
        "pairing-claimed" => "pairing-claimed",
        "pairing-rejected" => "pairing-rejected",
        "pairing-cancelled" => "pairing-cancelled",
        "device-revoked" => "device-revoked",
        "host-identity-mismatch" => "host-identity-mismatch",
        _ => "pairing-invalid",
    }
}
