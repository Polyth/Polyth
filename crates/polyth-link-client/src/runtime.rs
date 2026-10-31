use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::OpenOptions;
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
    bootstrap_claim_response, bootstrap_redirect_target, bootstrap_response, host_allowed, origin_allowed,
    proxy_session_from_cookie_header, requires_proxy_session, OwnedLoopback, ProxyBootstrap,
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
    open_control, read_bounded_line, read_control, write_all, write_control, write_stream_kind,
    ControlReader,
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
use tokio::sync::{broadcast, watch, Mutex, Notify};
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
    endpoint: iroh::Endpoint,
    /// The current transport. `None` while a lost connection is being
    /// re-established; the proxy keeps its origin and waits for the next one.
    link: watch::Sender<Option<Connection>>,
    /// Asks the control loop to prove the current link answers (a foreground
    /// return); a link that stays silent is replaced instead of waited out.
    probe: Arc<Notify>,
    proxy: ProxyHandle,
}

/// How long a proxied request waits for a lost link to come back before it
/// fails like any other unreachable request.
const LINK_WAIT: Duration = Duration::from_secs(15);
/// Bounds one reconnect handshake (QUIC connect + hello + accept).
const RECONNECT_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(10);
/// Backoff between failed reconnect attempts; the last value repeats.
const RECONNECT_BACKOFF_MS: [u64; 6] = [0, 250, 1_000, 2_000, 5_000, 10_000];
/// How long a liveness probe waits for the host's pong. After a suspension
/// the old connection still looks open: QUIC only notices a dead path after
/// its idle timeout, measured in awake time, so without a probe every request
/// and the page's WebSocket hang on it for tens of seconds.
const LIVENESS_TIMEOUT: Duration = Duration::from_secs(5);

struct ProxyHandle {
    origin: String,
    bootstrap: String,
    boot: Arc<Mutex<ProxyBootstrap>>,
    listener: OwnedLoopback,
    control: Arc<LoopbackControl>,
}

impl ProxyHandle {
    fn probe(&self) -> LoopbackProbe {
        LoopbackProbe {
            listener: self.listener.clone(),
            control: self.control.clone(),
        }
    }
}

/// Lets `status`/`connect` prove the loopback origin still serves the page.
///
/// iOS may reclaim (defunct) a suspended app's listening socket without the
/// accept loop ever seeing an error: `is_closed` stays false while every
/// connection to the port is refused or never accepted. The page then bounces
/// to the Connection Hub, which showed the server as "Connected", and tapping
/// it navigated the WebView to that dead origin again — WKWebView drops a
/// failed provisional navigation silently, so the tap did nothing until the
/// app was killed. Only an accepted connection counts as alive.
#[derive(Default)]
struct LoopbackControl {
    /// Peer ports of recently accepted loopback connections.
    accepted: std::sync::Mutex<VecDeque<u16>>,
    accepted_changed: Notify,
    /// Asks the accept loop to drop its socket and reclaim the same port.
    rebind: Notify,
    #[cfg(test)]
    defunct: Notify,
}

#[derive(Clone)]
struct LoopbackProbe {
    listener: OwnedLoopback,
    control: Arc<LoopbackControl>,
}

/// Peer ports remembered for liveness probes.
const ACCEPTED_PORT_HISTORY: usize = 32;
/// How long one probe waits for the accept loop to take its connection.
const LOOPBACK_PROBE_TIMEOUT: Duration = Duration::from_millis(750);
/// How long a failed probe waits for the accept loop to reclaim its port.
const LOOPBACK_RECOVERY_WAIT: Duration = Duration::from_millis(2_500);

const CLIENT_CONTEXT_PATH: &str = "/__polyth/client-context";
const CLIENT_CONTEXT_STORAGE_PREFIX: &str = "/__polyth/client-context/storage/";
// Composer drafts are small compared with file payloads but routinely exceed
// 16 KiB. Keep them app-owned and bounded without truncating ordinary pasted
// prompts; file bytes remain in native staging, never this store.
const CLIENT_STORAGE_VALUE_BYTES: usize = 256 * 1024;
const CLIENT_STORAGE_MAX_RECORDS: usize = 512;
const CLIENT_STORAGE_MAX_BYTES: u64 = 4 * 1024 * 1024;

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
            let probe = {
                let guard = state.lock().await;
                if guard.revoked_hosts.contains(id) {
                    return Ok(json!({ "state": "revoked", "error": LinkError::DeviceRevoked.code() }));
                }
                guard.sessions.get(id).map(|session| session.proxy.probe())
            };
            // "connected" promises the page's origin is served. A listener the
            // OS reclaimed is rebound on its port or closed here, so the shell
            // reconnects instead of reloading a dead origin.
            if let Some(probe) = probe {
                ensure_loopback(&probe).await;
            }
            let guard = state.lock().await;
            if guard.revoked_hosts.contains(id) {
                return Ok(json!({ "state": "revoked", "error": LinkError::DeviceRevoked.code() }));
            }
            if let Some(session) = guard
                .sessions
                .get(id)
                .filter(|session| !session.proxy.listener.is_closed())
            {
                // A status read is how the native shells react to returning to
                // the foreground: let iroh re-probe paths that went stale while
                // the app was suspended instead of waiting for an idle timeout.
                let endpoint = session.endpoint.clone();
                tokio::spawn(async move { endpoint.network_change().await });
                // The connection may have died while suspended without either
                // side noticing yet: ask the host to answer now.
                session.probe.notify_one();
                // While a lost link is re-established behind the unchanged
                // origin there is no transport to report.
                let transport = session.link.borrow().as_ref().map(path_transport);
                let mut status = json!({
                    "state": "connected",
                    "reconnecting": transport.is_none(),
                    "origin": session.proxy.origin,
                    "connectionId": session.connection_id,
                    "hostEndpointId": session.host_endpoint_id,
                    "hostLabel": session.host_label,
                });
                if let Some(transport) = transport {
                    status["transport"] = Value::String(transport.into());
                }
                Ok(status)
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
                let (link, link_rx) = watch::channel(Some(attempt.connection.clone()));
                let probe = Arc::new(Notify::new());
                let reconnect_addr = endpoint_addr_from_ticket(&attempt.ticket)
                    .unwrap_or_else(|_| iroh::EndpointAddr::new(attempt.connection.remote_id()));
                let proxy = start_proxy(
                    link_rx,
                    web_dist,
                    data_dir.clone(),
                    connection_id.clone(),
                )
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
                            endpoint: attempt.endpoint.clone(),
                            link,
                            probe: probe.clone(),
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
                    attempt.endpoint,
                    reconnect_addr,
                    probe,
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
        guard.sessions.get(id).filter(|session| !session.proxy.listener.is_closed()).map(|session| {
            (
                session.proxy.origin.clone(),
                session.proxy.boot.clone(),
                session.proxy.probe(),
            )
        })
    };
    // A session whose loopback origin died is replaced below, not reused:
    // handing out its bootstrap would send the WebView to a port nobody serves.
    let live = match live {
        Some((origin, boot, probe)) if ensure_loopback(&probe).await => Some((origin, boot)),
        _ => None,
    };
    if let Some((origin, boot)) = live {
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
        .connect(addr.clone(), POLYTH_LINK_ALPN.as_bytes())
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
    let (link, link_rx) = watch::channel(Some(connection.clone()));
    let probe = Arc::new(Notify::new());
    let proxy = start_proxy(link_rx, web_dist, data_dir.clone(), id.to_string())
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
                endpoint: endpoint.clone(),
                link,
                probe: probe.clone(),
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
        endpoint,
        addr,
        probe,
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
    if let Some(connection) = session.link.send_replace(None) {
        connection.close(0u32.into(), reason);
    }
    session.endpoint.close().await;
}

async fn start_proxy(
    link: watch::Receiver<Option<Connection>>,
    web_dist: Option<PathBuf>,
    data_dir: PathBuf,
    connection_scope: String,
) -> Result<ProxyHandle, LinkError> {
    let (listener, owned) = polyth_link_core::local_proxy::bind_owned_loopback().await?;
    let port = owned.port;
    let closer = owned.clone();
    let boot = Arc::new(Mutex::new(ProxyBootstrap::new(port)));
    let bootstrap = boot.lock().await.bootstrap_url();
    let origin = format!("http://127.0.0.1:{port}");
    let mut shutdown_rx = owned.subscribe();
    let boot_handle = boot.clone();
    let storage_lock = Arc::new(Mutex::new(()));
    let control = Arc::new(LoopbackControl::default());
    let loop_control = control.clone();
    tokio::spawn(async move {
        let control = loop_control;
        let mut listener = Some(listener);
        let mut failures = 0usize;
        loop {
            let event = match listener.as_ref() {
                Some(current) => tokio::select! {
                    _ = shutdown_rx.changed() => AcceptEvent::Shutdown,
                    _ = control.rebind.notified() => AcceptEvent::Rebind,
                    _ = defunct_signal(&control) => AcceptEvent::Defunct,
                    accepted = current.accept() => AcceptEvent::Accepted(accepted),
                },
                // Only a simulated defunct socket parks here (tests).
                None => tokio::select! {
                    _ = shutdown_rx.changed() => AcceptEvent::Shutdown,
                    _ = control.rebind.notified() => AcceptEvent::Rebind,
                },
            };
            let accepted = match event {
                AcceptEvent::Shutdown => break,
                AcceptEvent::Defunct => {
                    drop(listener.take());
                    continue;
                }
                AcceptEvent::Rebind => {
                    // Release the dead socket before reclaiming its port.
                    drop(listener.take());
                    listener = rebind_loopback(port).await;
                    failures = 0;
                    if listener.is_none() {
                        break;
                    }
                    continue;
                }
                AcceptEvent::Accepted(accepted) => accepted,
            };
            let Ok((stream, peer)) = accepted else {
                failures += 1;
                tokio::time::sleep(Duration::from_millis(50)).await;
                if failures >= TRANSIENT_ACCEPT_FAILURES {
                    drop(listener.take());
                    listener = rebind_loopback(port).await;
                    failures = 0;
                    if listener.is_none() {
                        break;
                    }
                }
                continue;
            };
            failures = 0;
            control.record_accepted(peer.port());
            let link = link.clone();
            let web_dist = web_dist.clone();
            let boot = boot.clone();
            let data_dir = data_dir.clone();
            let connection_scope = connection_scope.clone();
            let storage_lock = storage_lock.clone();
            tokio::spawn(async move {
                let _ = handle_proxy_conn(
                    stream,
                    link,
                    web_dist,
                    boot,
                    data_dir,
                    connection_scope,
                    storage_lock,
                )
                .await;
            });
        }
        // Whatever ended the loop, the origin is gone: let status/connect see
        // it so the native shell reconnects instead of trusting a dead port.
        closer.close();
    });
    Ok(ProxyHandle {
        origin,
        bootstrap,
        boot: boot_handle,
        listener: owned,
        control,
    })
}

enum AcceptEvent {
    Shutdown,
    Rebind,
    Defunct,
    Accepted(std::io::Result<(TcpStream, std::net::SocketAddr)>),
}

#[cfg(test)]
async fn defunct_signal(control: &LoopbackControl) {
    control.defunct.notified().await
}

#[cfg(not(test))]
async fn defunct_signal(_control: &LoopbackControl) {
    std::future::pending::<()>().await
}

impl LoopbackControl {
    fn record_accepted(&self, peer_port: u16) {
        {
            let mut accepted = self.accepted.lock().unwrap_or_else(|error| error.into_inner());
            if accepted.len() >= ACCEPTED_PORT_HISTORY {
                accepted.pop_front();
            }
            accepted.push_back(peer_port);
        }
        self.accepted_changed.notify_waiters();
    }

    fn take_accepted(&self, peer_port: u16) -> bool {
        let mut accepted = self.accepted.lock().unwrap_or_else(|error| error.into_inner());
        match accepted.iter().position(|port| *port == peer_port) {
            Some(index) => {
                accepted.remove(index);
                true
            }
            None => false,
        }
    }
}

/// True when this proxy's accept loop takes a fresh loopback connection. A
/// bare TCP connect is not enough: a reclaimed listener can still complete
/// the handshake in the kernel without ever handing the socket to us.
async fn loopback_answers(probe: &LoopbackProbe) -> bool {
    let attempt = async {
        let stream = TcpStream::connect(("127.0.0.1", probe.listener.port)).await.ok()?;
        let probe_port = stream.local_addr().ok()?.port();
        loop {
            let changed = probe.control.accepted_changed.notified();
            if probe.control.take_accepted(probe_port) {
                // Closing right away ends the handler at its first read.
                drop(stream);
                return Some(());
            }
            changed.await;
        }
    };
    matches!(
        tokio::time::timeout(LOOPBACK_PROBE_TIMEOUT, attempt).await,
        Ok(Some(()))
    )
}

/// Keep a proxy's origin serving or mark it closed. A dead listener is asked
/// to reclaim its port (the page's origin, cookie and storage stay valid);
/// when that fails the listener is closed so callers replace the session.
async fn ensure_loopback(probe: &LoopbackProbe) -> bool {
    if probe.listener.is_closed() {
        return false;
    }
    if loopback_answers(probe).await {
        return true;
    }
    probe.control.rebind.notify_one();
    let deadline = Instant::now() + LOOPBACK_RECOVERY_WAIT;
    while Instant::now() < deadline && !probe.listener.is_closed() {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if loopback_answers(probe).await {
            return true;
        }
    }
    probe.listener.close();
    false
}

/// Consecutive accept errors tolerated before the listener counts as dead.
const TRANSIENT_ACCEPT_FAILURES: usize = 3;

/// iOS may reclaim a suspended app's listening socket. Rebinding the same
/// port keeps the page's origin and proxy cookie valid; `None` when the port
/// cannot be reclaimed.
async fn rebind_loopback(port: u16) -> Option<tokio::net::TcpListener> {
    for attempt in 1..=5u64 {
        if let Ok(listener) = tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            return Some(listener);
        }
        tokio::time::sleep(Duration::from_millis(100 * attempt)).await;
    }
    None
}

async fn handle_proxy_conn(
    mut stream: TcpStream,
    link: watch::Receiver<Option<Connection>>,
    web_dist: Option<PathBuf>,
    boot: Arc<Mutex<ProxyBootstrap>>,
    data_dir: PathBuf,
    connection_scope: String,
    storage_lock: Arc<Mutex<()>>,
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
        // GET serves the page; its same-origin POST consumes the nonce and
        // sets the session cookie (see `bootstrap_response`).
        let response = if method.eq_ignore_ascii_case("POST") {
            match boot.lock().await.consume_nonce(rest) {
                Ok(session) => bootstrap_claim_response(port, &session),
                Err(error) => {
                    write_http(&mut stream, 400, "invalid bootstrap").await?;
                    return Err(error);
                }
            }
        } else if method.eq_ignore_ascii_case("GET") {
            match bootstrap_redirect_target(query.as_deref()) {
                Ok(location) => bootstrap_response(&location),
                Err(error) => {
                    write_http(&mut stream, 400, "invalid redirect").await?;
                    return Err(error);
                }
            }
        } else {
            write_http(&mut stream, 405, "method not allowed").await?;
            return Err(LinkError::ProxyBootstrapInvalid);
        };
        stream
            .write_all(response.as_bytes())
            .await
            .map_err(|_| LinkError::TransportProtocolError)?;
        return Ok(());
    }
    let cookie = parsed.header("cookie");
    let session_ok = {
        let guard = boot.lock().await;
        cookie
            .and_then(|cookie| proxy_session_from_cookie_header(cookie, port))
            .map(|value| guard.session_valid(value))
            .unwrap_or(false)
    };
    if !session_ok {
        if requires_proxy_session(&method, &path) {
            write_http(&mut stream, 401, "authentication required").await?;
            return Err(LinkError::ProxySessionInvalid);
        }
        // Without a session only the public static shell is reachable.
        return serve_static(&mut stream, web_dist.as_deref(), &path).await;
    }
    if path == CLIENT_CONTEXT_PATH || path.starts_with(CLIENT_CONTEXT_STORAGE_PREFIX) {
        return handle_client_context(
            &mut stream,
            parsed,
            &method,
            &path,
            &data_dir,
            &connection_scope,
            storage_lock,
        )
        .await;
    }
    let websocket_path = path == "/ws" || path.starts_with("/ws/");
    if path.starts_with("/api/") || websocket_path {
        let connection = current_link(link, LINK_WAIT).await?;
        if parsed.is_websocket_upgrade() || websocket_path {
            return proxy_ws(stream, parsed, &connection, &raw_path).await;
        }
        return proxy_http(stream, parsed, &connection, &method, &raw_path).await;
    }
    serve_static(&mut stream, web_dist.as_deref(), &path).await
}

async fn handle_client_context(
    stream: &mut TcpStream,
    parsed: polyth_link_core::http_io::ParsedHttpHead,
    method: &str,
    path: &str,
    data_dir: &Path,
    connection_scope: &str,
    storage_lock: Arc<Mutex<()>>,
) -> Result<(), LinkError> {
    if path == CLIENT_CONTEXT_PATH {
        if method != "GET" {
            return write_http(stream, 404, "not found").await;
        }
        return write_json(
            stream,
            200,
            &json!({ "protocolVersion": 1, "connectionScope": connection_scope }).to_string(),
        )
        .await;
    }
    let Some(key) = path.strip_prefix(CLIENT_CONTEXT_STORAGE_PREFIX) else {
        return write_http(stream, 404, "not found").await;
    };
    if !client_storage_key_valid(key) {
        return write_http(stream, 400, "invalid storage key").await;
    }
    let _guard = storage_lock.lock().await;
    let root = client_storage_root(data_dir, connection_scope);
    if ensure_client_storage_root(&root).is_err() {
        return write_http(stream, 400, "storage unavailable").await;
    }
    let record = root.join(key);
    match method {
        "GET" => match regular_client_storage_record(&record) {
            Ok(true) => match std::fs::read_to_string(&record) {
                Ok(value) if value.len() <= CLIENT_STORAGE_VALUE_BYTES => {
                    write_json(stream, 200, &json!({ "value": value }).to_string()).await
                }
                Ok(_) => write_http(stream, 400, "invalid storage record").await,
                Err(_) => write_http(stream, 400, "storage unavailable").await,
            },
            Ok(false) => write_http(stream, 404, "not found").await,
            Err(_) => write_http(stream, 400, "storage unavailable").await,
        },
        "DELETE" => match regular_client_storage_record(&record) {
            Ok(false) => write_empty(stream, 204).await,
            Ok(true) => match std::fs::remove_file(&record) {
                Ok(()) => write_empty(stream, 204).await,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    write_empty(stream, 204).await
                }
                Err(_) => write_http(stream, 400, "storage unavailable").await,
            }
            Err(_) => write_http(stream, 400, "storage unavailable").await,
        },
        "PUT" => {
            let value = match read_client_storage_body(stream, &parsed).await {
                Ok(value) => value,
                Err(error) => {
                    let status = if error == LinkError::RequestTooLarge { 413 } else { 400 };
                    return write_http(stream, status, "invalid storage value").await;
                }
            };
            match write_client_storage_record(&root, key, &value) {
                Ok(()) => write_empty(stream, 204).await,
                Err(LinkError::RequestTooLarge) => write_http(stream, 413, "storage quota exceeded").await,
                Err(_) => write_http(stream, 400, "storage unavailable").await,
            }
        }
        _ => write_http(stream, 404, "not found").await,
    }
}

fn client_storage_key_valid(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn client_storage_root(data_dir: &Path, connection_scope: &str) -> PathBuf {
    // Encode instead of interpolating the opaque endpoint ID into a path.
    data_dir.join("client-context").join(hex::encode(connection_scope))
}

fn ensure_client_storage_root(root: &Path) -> Result<(), LinkError> {
    let Some(parent) = root.parent() else {
        return Err(LinkError::PairingStorageFailed);
    };
    ensure_private_directory(parent)?;
    ensure_private_directory(root)
}

fn ensure_private_directory(path: &Path) -> Result<(), LinkError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(LinkError::PairingStorageFailed),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(path).map_err(|_| LinkError::PairingStorageFailed)?;
            let metadata = std::fs::symlink_metadata(path).map_err(|_| LinkError::PairingStorageFailed)?;
            if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
                Ok(())
            } else {
                Err(LinkError::PairingStorageFailed)
            }
        }
        Err(_) => Err(LinkError::PairingStorageFailed),
    }
}

fn regular_client_storage_record(path: &Path) -> Result<bool, LinkError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() && !metadata.file_type().is_symlink() => Ok(true),
        Ok(_) => Err(LinkError::PairingStorageFailed),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(LinkError::PairingStorageFailed),
    }
}

async fn read_client_storage_body(
    stream: &mut TcpStream,
    parsed: &polyth_link_core::http_io::ParsedHttpHead,
) -> Result<String, LinkError> {
    if parsed.transfer_encoding_chunked()? {
        return Err(LinkError::RequestHeaderInvalid);
    }
    let length = parsed.content_length()?.ok_or(LinkError::RequestHeaderInvalid)?;
    if length > CLIENT_STORAGE_VALUE_BYTES as u64 || parsed.leftover.len() > length as usize {
        return Err(LinkError::RequestTooLarge);
    }
    let mut value = parsed.leftover.clone();
    value.resize(length as usize, 0);
    if value.len() > parsed.leftover.len() {
        stream
            .read_exact(&mut value[parsed.leftover.len()..])
            .await
            .map_err(|_| LinkError::RequestHeaderInvalid)?;
    }
    String::from_utf8(value).map_err(|_| LinkError::RequestHeaderInvalid)
}

fn write_client_storage_record(root: &Path, key: &str, value: &str) -> Result<(), LinkError> {
    if value.len() > CLIENT_STORAGE_VALUE_BYTES {
        return Err(LinkError::RequestTooLarge);
    }
    ensure_client_storage_root(root)?;
    let mut total = 0_u64;
    let mut records = 0_usize;
    for entry in std::fs::read_dir(root).map_err(|_| LinkError::PairingStorageFailed)? {
        let entry = entry.map_err(|_| LinkError::PairingStorageFailed)?;
        let name = entry.file_name();
        if name
            .to_str()
            .is_some_and(|name| name.starts_with('.') && name.ends_with(".tmp"))
        {
            let metadata = std::fs::symlink_metadata(entry.path())
                .map_err(|_| LinkError::PairingStorageFailed)?;
            if metadata.file_type().is_dir() {
                return Err(LinkError::PairingStorageFailed);
            }
            std::fs::remove_file(entry.path()).map_err(|_| LinkError::PairingStorageFailed)?;
            continue;
        }
        if name.to_str().is_none_or(|name| !client_storage_key_valid(name)) {
            continue;
        }
        let metadata = std::fs::symlink_metadata(entry.path()).map_err(|_| LinkError::PairingStorageFailed)?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(LinkError::PairingStorageFailed);
        }
        if name != key { records += 1; total = total.saturating_add(metadata.len()); }
    }
    let record = root.join(key);
    if !regular_client_storage_record(&record)? { records += 1; }
    total = total.saturating_add(value.len() as u64);
    if records > CLIENT_STORAGE_MAX_RECORDS || total > CLIENT_STORAGE_MAX_BYTES {
        return Err(LinkError::RequestTooLarge);
    }
    let (temp, mut file) = create_client_storage_temp(root, key)?;
    use std::io::Write;
    if file.write_all(value.as_bytes()).and_then(|_| file.sync_all()).is_err() {
        let _ = std::fs::remove_file(&temp);
        return Err(LinkError::PairingStorageFailed);
    }
    std::fs::rename(&temp, &record).map_err(|_| LinkError::PairingStorageFailed)?;
    #[cfg(unix)]
    {
        std::fs::File::open(root)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| LinkError::PairingStorageFailed)?;
    }
    Ok(())
}

fn create_client_storage_temp(root: &Path, key: &str) -> Result<(PathBuf, std::fs::File), LinkError> {
    for _ in 0..8 {
        let mut nonce = [0_u8; 16];
        rand::thread_rng().fill_bytes(&mut nonce);
        let temp = root.join(format!(".{key}.{}.tmp", hex::encode(nonce)));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&temp) {
            Ok(file) => return Ok((temp, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(LinkError::PairingStorageFailed),
        }
    }
    Err(LinkError::PairingStorageFailed)
}

fn split_path_query(raw: &str) -> (String, Option<String>) {
    match raw.split_once('?') {
        Some((path, query)) => (path.to_string(), Some(query.to_string())),
        None => (raw.to_string(), None),
    }
}

/// Why a control stream stopped serving a live connection.
#[derive(Debug, PartialEq, Eq)]
enum ControlEnd {
    /// The host revoked this device: the session ends for good.
    Revoked,
    /// The transport went away (suspend, network change, host restart).
    Lost,
}

async fn serve_control(send: &mut SendStream, recv: &mut RecvStream, probe: &Notify) -> ControlEnd {
    // `ControlReader` keeps a partial frame across the select below.
    let mut reader = ControlReader::new(recv);
    let mut pending: Option<([u8; 16], tokio::time::Instant)> = None;
    loop {
        let deadline = pending.map(|(_, deadline)| deadline);
        let message = tokio::select! {
            message = reader.read() => message,
            _ = probe.notified(), if pending.is_none() => {
                let mut nonce = [0u8; 16];
                rand::thread_rng().fill_bytes(&mut nonce);
                if write_control(send, &ControlMessage::Ping { nonce }).await.is_err() {
                    return ControlEnd::Lost;
                }
                pending = Some((nonce, tokio::time::Instant::now() + LIVENESS_TIMEOUT));
                continue;
            }
            _ = tokio::time::sleep_until(deadline.unwrap_or_else(tokio::time::Instant::now)),
                if deadline.is_some() => return ControlEnd::Lost,
        };
        match message {
            Ok(ControlMessage::Pong { nonce }) => {
                if pending.is_some_and(|(expected, _)| expected == nonce) {
                    pending = None;
                }
            }
            Ok(ControlMessage::Ping { nonce }) => {
                if write_control(send, &ControlMessage::Pong { nonce })
                    .await
                    .is_err()
                {
                    return ControlEnd::Lost;
                }
            }
            Ok(ControlMessage::DeviceRevoked) => return ControlEnd::Revoked,
            Ok(ControlMessage::ConnectionRejected { code }) if code == "device-revoked" => {
                return ControlEnd::Revoked
            }
            Ok(ControlMessage::Shutdown { .. }) => return ControlEnd::Lost,
            Ok(ControlMessage::ConnectionAccepted { .. })
            | Ok(ControlMessage::GrantRevisionChanged { .. })
            | Ok(ControlMessage::TransportStatus { .. })
            | Ok(ControlMessage::HostDescriptorUpdated { .. }) => {}
            Ok(_) | Err(_) => return ControlEnd::Lost,
        }
    }
}

/// Outcome of one reconnect handshake that did not produce a connection.
#[derive(Debug, PartialEq, Eq)]
enum ReconnectFailure {
    /// Network-level failure; try again after a backoff.
    Transient,
    /// The host answered authoritatively (revoked, unknown device, identity
    /// or version mismatch); retrying cannot succeed.
    Rejected { revoked: bool },
}

fn classify_reconnect_rejection(code: &str) -> ReconnectFailure {
    ReconnectFailure::Rejected {
        revoked: code == LinkError::DeviceRevoked.code(),
    }
}

fn reconnect_backoff(attempt: usize) -> Duration {
    let index = attempt.min(RECONNECT_BACKOFF_MS.len() - 1);
    Duration::from_millis(RECONNECT_BACKOFF_MS[index])
}

/// Re-open a trusted connection on the session's existing endpoint. The
/// endpoint already holds the device key, so no identity secret is needed.
async fn reconnect_link(
    endpoint: &iroh::Endpoint,
    addr: iroh::EndpointAddr,
    host_id: &str,
) -> Result<(Connection, SendStream, RecvStream), ReconnectFailure> {
    let connection = endpoint
        .connect(addr, POLYTH_LINK_ALPN.as_bytes())
        .await
        .map_err(|_| ReconnectFailure::Transient)?;
    if connection.remote_id().to_string() != host_id {
        connection.close(0u32.into(), b"identity-mismatch");
        return Err(classify_reconnect_rejection(
            LinkError::HostIdentityMismatch.code(),
        ));
    }
    let handshake = async {
        let (mut send, mut recv) = connection
            .open_bi()
            .await
            .map_err(|_| ReconnectFailure::Transient)?;
        let _ = send.set_priority(PRI_CONTROL);
        open_control(&mut send)
            .await
            .map_err(|_| ReconnectFailure::Transient)?;
        write_control(
            &mut send,
            &ControlMessage::ConnectionHello {
                version: PROTOCOL_VERSION,
                device_endpoint: endpoint.id().to_string(),
            },
        )
        .await
        .map_err(|_| ReconnectFailure::Transient)?;
        let response = read_control(&mut recv)
            .await
            .map_err(|_| ReconnectFailure::Transient)?;
        validate_connection_response(response).map_err(classify_reconnect_rejection)?;
        Ok((send, recv))
    };
    match handshake.await {
        Ok((send, recv)) => Ok((connection, send, recv)),
        Err(failure) => {
            connection.close(0u32.into(), b"reconnect-failed");
            Err(failure)
        }
    }
}

/// Publish `connection` as the session's current link. Returns false when the
/// session was disconnected, forgotten or replaced meanwhile.
async fn publish_link(
    state: &Arc<Mutex<ClientState>>,
    connection_id: &str,
    generation: u64,
    connection: Option<Connection>,
) -> bool {
    let guard = state.lock().await;
    match guard.sessions.get(connection_id) {
        Some(session) if session.generation == generation => {
            session.link.send_replace(connection);
            true
        }
        _ => false,
    }
}

/// Wait for a usable link. A connection that has already closed is treated
/// like a missing one: the control loop is about to replace it.
async fn current_link(
    mut link: watch::Receiver<Option<Connection>>,
    wait: Duration,
) -> Result<Connection, LinkError> {
    let usable = |current: &Option<Connection>| {
        current
            .as_ref()
            .is_some_and(|connection| connection.close_reason().is_none())
    };
    let found = tokio::time::timeout(wait, link.wait_for(usable))
        .await
        .map_err(|_| LinkError::TransportUnavailable)?
        .map_err(|_| LinkError::TransportUnavailable)?;
    found.clone().ok_or(LinkError::TransportUnavailable)
}

#[allow(clippy::too_many_arguments)]
fn spawn_control_loop(
    state: Arc<Mutex<ClientState>>,
    connection_id: String,
    generation: u64,
    mut send: SendStream,
    mut recv: RecvStream,
    mut connection: Connection,
    proxy_listener: OwnedLoopback,
    endpoint: iroh::Endpoint,
    addr: iroh::EndpointAddr,
    probe: Arc<Notify>,
) {
    tokio::spawn(async move {
        loop {
            if serve_control(&mut send, &mut recv, &probe).await == ControlEnd::Revoked {
                proxy_listener.close();
                connection.close(0u32.into(), b"revoked");
                finish_session(state, &connection_id, generation, true).await;
                return;
            }
            connection.close(0u32.into(), b"closed");
            // Losing the transport is routine on a phone (suspension outlasts
            // the QUIC idle timeout, Wi-Fi/cellular hand-off, host restart).
            // Keep the loopback proxy and its origin/cookie, park requests and
            // reconnect on the same endpoint so the page never sees a dead
            // origin. Only an authoritative host answer ends the session.
            if !publish_link(&state, &connection_id, generation, None).await {
                return;
            }
            let mut attempt = 0usize;
            loop {
                tokio::time::sleep(reconnect_backoff(attempt)).await;
                attempt += 1;
                if !publish_link(&state, &connection_id, generation, None).await {
                    return;
                }
                endpoint.network_change().await;
                let result = tokio::time::timeout(
                    RECONNECT_ATTEMPT_TIMEOUT,
                    reconnect_link(&endpoint, addr.clone(), &connection_id),
                )
                .await
                .unwrap_or(Err(ReconnectFailure::Transient));
                match result {
                    Ok((next, next_send, next_recv)) => {
                        if !publish_link(&state, &connection_id, generation, Some(next.clone()))
                            .await
                        {
                            next.close(0u32.into(), b"closed");
                            return;
                        }
                        connection = next;
                        send = next_send;
                        recv = next_recv;
                        break;
                    }
                    Err(ReconnectFailure::Transient) => {}
                    Err(ReconnectFailure::Rejected { revoked }) => {
                        proxy_listener.close();
                        finish_session(state, &connection_id, generation, revoked).await;
                        return;
                    }
                }
            }
        }
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
        if let Some(connection) = session.link.send_replace(None) {
            connection.close(0u32.into(), b"closed");
        }
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
            deflate: true,
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
    // An older host ignores the offer and answers without the header.
    let deflate = response.headers.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case(polyth_link_core::protocol::WS_DEFLATE_HEADER) && value == "1"
    });
    proxy_tungstenite_to_link(ws, send, recv, deflate).await
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
    write_response(stream, status, "application/json", &payload).await
}

async fn write_json(stream: &mut TcpStream, status: u16, body: &str) -> Result<(), LinkError> {
    write_response(stream, status, "application/json", body).await
}

async fn write_empty(stream: &mut TcpStream, status: u16) -> Result<(), LinkError> {
    write_response(stream, status, "text/plain", "").await
}

async fn write_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &str,
) -> Result<(), LinkError> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        411 => "Length Required",
        413 => "Payload Too Large",
        _ => "Error",
    };
    let headers = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(headers.as_bytes())
        .await
        .map_err(|_| LinkError::TransportProtocolError)?;
    stream
        .write_all(body.as_bytes())
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

    #[test]
    fn local_client_storage_is_bounded_and_connection_scoped() {
        let dir = tempdir().unwrap();
        let a = client_storage_root(dir.path(), "connection-a");
        let b = client_storage_root(dir.path(), "connection-b");
        write_client_storage_record(&a, "draft.v1", "draft for a").unwrap();
        write_client_storage_record(&b, "draft.v1", "draft for b").unwrap();
        assert_eq!(std::fs::read_to_string(a.join("draft.v1")).unwrap(), "draft for a");
        assert_eq!(std::fs::read_to_string(b.join("draft.v1")).unwrap(), "draft for b");
        assert_ne!(a, b);
        assert!(client_storage_key_valid("draft.v1_1-2"));
        assert!(!client_storage_key_valid("../draft"));
        assert_eq!(
            write_client_storage_record(&a, "too-large", &"x".repeat(CLIENT_STORAGE_VALUE_BYTES + 1)),
            Err(LinkError::RequestTooLarge)
        );
    }

    #[test]
    fn stale_interrupted_temp_and_repeated_writers_do_not_block_reopen() {
        let dir = tempdir().unwrap();
        let root = client_storage_root(dir.path(), "connection-a");
        ensure_client_storage_root(&root).unwrap();
        std::fs::write(root.join(".draft.v1.1234.tmp"), b"interrupted").unwrap();
        write_client_storage_record(&root, "draft.v1", "after restart").unwrap();
        assert!(!root.join(".draft.v1.1234.tmp").exists());
        for value in ["first", "second", "third", "fourth"] {
            write_client_storage_record(&root, "draft.v1", value).unwrap();
        }
        let value = std::fs::read_to_string(root.join("draft.v1")).unwrap();
        assert!(["first", "second", "third", "fourth"].contains(&value.as_str()));
    }

    #[cfg(unix)]
    #[test]
    fn client_storage_refuses_symlink_roots_and_records() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let root = client_storage_root(dir.path(), "connection-a");
        std::fs::create_dir(dir.path().join("client-context")).unwrap();
        symlink(outside.path(), &root).unwrap();
        assert_eq!(ensure_client_storage_root(&root), Err(LinkError::PairingStorageFailed));

        let safe = client_storage_root(dir.path(), "connection-b");
        ensure_client_storage_root(&safe).unwrap();
        symlink(outside.path().join("missing"), safe.join("draft.v1")).unwrap();
        assert_eq!(
            write_client_storage_record(&safe, "draft.v1", "no escape"),
            Err(LinkError::PairingStorageFailed)
        );
    }

    /// What the fake host answers to a trusted `ConnectionHello`.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum FakeHostAnswer {
        Accept,
        /// Accepts, then never answers on the control stream: a connection
        /// whose path died while the phone was suspended.
        Mute,
        Revoked,
    }

    /// A minimal trusted host: accepts each connection's hello with the
    /// scripted answers (the last one repeats), answers every HTTP stream with
    /// `conn-<n>` and hands each live connection to the test so it can drop it.
    fn spawn_fake_host(
        host: iroh::Endpoint,
        answers: Vec<FakeHostAnswer>,
    ) -> tokio::sync::mpsc::UnboundedReceiver<Connection> {
        use polyth_link_core::protocol::{HttpResponseHeadV1, STREAM_CONTROL};
        use polyth_link_core::wire::{read_len_prefixed, read_stream_kind};
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut index = 0usize;
            while let Some(incoming) = host.accept().await {
                let Ok(connecting) = incoming.accept() else { continue };
                let Ok(connection) = connecting.await else { continue };
                index += 1;
                let answer = answers[(index - 1).min(answers.len() - 1)];
                let tx = tx.clone();
                tokio::spawn(async move {
                    let (mut send, mut recv) = connection.accept_bi().await.unwrap();
                    assert_eq!(read_stream_kind(&mut recv).await.unwrap(), STREAM_CONTROL);
                    let ControlMessage::ConnectionHello { device_endpoint, .. } =
                        read_control(&mut recv).await.unwrap()
                    else {
                        panic!("expected a trusted hello");
                    };
                    assert_eq!(device_endpoint, connection.remote_id().to_string());
                    if answer == FakeHostAnswer::Revoked {
                        let _ = write_control(
                            &mut send,
                            &ControlMessage::ConnectionRejected { code: "device-revoked".into() },
                        )
                        .await;
                        let _ = send.finish();
                        let _ = connection.closed().await;
                        return;
                    }
                    write_control(
                        &mut send,
                        &ControlMessage::ConnectionAccepted {
                            version: PROTOCOL_VERSION,
                            connection_id: format!("conn-{index}"),
                            grant_revision: 1,
                        },
                    )
                    .await
                    .unwrap();
                    let _ = tx.send(connection.clone());
                    // Keep the control stream open for the connection lifetime
                    // and answer pings like the real host, unless muted.
                    tokio::spawn(async move {
                        let mut send = send;
                        let mut recv = recv;
                        while let Ok(message) = read_control(&mut recv).await {
                            if let (ControlMessage::Ping { nonce }, FakeHostAnswer::Accept) =
                                (message, answer)
                            {
                                let _ = write_control(&mut send, &ControlMessage::Pong { nonce }).await;
                            }
                        }
                    });
                    while let Ok((mut send, mut recv)) = connection.accept_bi().await {
                        assert_eq!(read_stream_kind(&mut recv).await.unwrap(), STREAM_HTTP);
                        let payload =
                            read_len_prefixed(&mut recv, Limits::v1().http_head_bytes).await.unwrap();
                        let mut framed = (payload.len() as u32).to_be_bytes().to_vec();
                        framed.extend_from_slice(&payload);
                        let (head, _): (HttpRequestHeadV1, usize) = decode_head(&framed).unwrap();
                        let body = format!("conn-{index}");
                        let response = HttpResponseHeadV1 {
                            version: PROTOCOL_VERSION,
                            request_id: head.request_id,
                            status: 200,
                            headers: vec![("content-type".into(), "text/plain".into())],
                            body_length: Some(body.len() as u64),
                        };
                        write_all(&mut send, &encode_head(&response).unwrap()).await.unwrap();
                        write_all(&mut send, body.as_bytes()).await.unwrap();
                        let _ = send.finish();
                    }
                });
            }
        });
        rx
    }

    struct LinkFixture {
        _dir: tempfile::TempDir,
        state: Arc<Mutex<ClientState>>,
        host_id: String,
        port: u16,
        cookie: String,
    }

    async fn link_fixture(answers: Vec<FakeHostAnswer>) -> (LinkFixture, tokio::sync::mpsc::UnboundedReceiver<Connection>) {
        let dir = tempdir().unwrap();
        let host_identity = identity::load_or_create(dir.path().join("host")).unwrap();
        let device_identity = identity::load_or_create(dir.path().join("device")).unwrap();
        let host = bind_link_endpoint(host_identity.secret_key(), TransportPolicy::AirGapped)
            .await
            .unwrap();
        let device = bind_link_endpoint(device_identity.secret_key(), TransportPolicy::AirGapped)
            .await
            .unwrap();
        let host_id = host.id().to_string();
        let addr = host.addr();
        let connections = spawn_fake_host(host, answers);
        let (connection, send, recv) = reconnect_link(&device, addr.clone(), &host_id)
            .await
            .unwrap_or_else(|failure| panic!("initial connect failed: {failure:?}"));
        let state = Arc::new(Mutex::new(new_state(dir.path().to_path_buf(), None)));
        let (link, link_rx) = watch::channel(Some(connection.clone()));
        let probe = Arc::new(Notify::new());
        let proxy = start_proxy(link_rx, None, dir.path().to_path_buf(), host_id.clone())
            .await
            .unwrap();
        let port = proxy.listener.port;
        let cookie = format!(
            "{}={}",
            polyth_link_core::local_proxy::proxy_session_cookie(port),
            proxy.boot.lock().await.session_hex()
        );
        let proxy_listener = proxy.listener.clone();
        let generation = {
            let mut guard = state.lock().await;
            let generation = next_generation(&mut guard);
            guard.sessions.insert(
                host_id.clone(),
                LiveSession {
                    generation,
                    connection_id: host_id.clone(),
                    host_endpoint_id: host_id.clone(),
                    host_label: "Desk".into(),
                    endpoint: device.clone(),
                    link,
                    probe: probe.clone(),
                    proxy,
                },
            );
            generation
        };
        spawn_control_loop(
            state.clone(),
            host_id.clone(),
            generation,
            send,
            recv,
            connection,
            proxy_listener,
            device,
            addr,
            probe,
        );
        (
            LinkFixture { _dir: dir, state, host_id, port, cookie },
            connections,
        )
    }

    async fn proxied_get(port: u16, cookie: &str) -> std::io::Result<String> {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await?;
        let request = format!(
            "GET /api/ping HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nCookie: {cookie}\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).await?;
        let mut response = String::new();
        stream.read_to_string(&mut response).await?;
        Ok(response)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn lost_transport_reconnects_behind_the_same_loopback_origin() {
        let (fixture, mut connections) = link_fixture(vec![FakeHostAnswer::Accept]).await;
        let first = connections.recv().await.unwrap();
        let response = proxied_get(fixture.port, &fixture.cookie).await.unwrap();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.ends_with("conn-1"), "{response}");

        // The host drops the link (a phone suspended past the idle timeout, a
        // network hand-off or a host restart all look like this to the client).
        first.close(0u32.into(), b"gone");
        let response = tokio::time::timeout(
            Duration::from_secs(20),
            proxied_get(fixture.port, &fixture.cookie),
        )
        .await
        .expect("request parked until the link returned")
        .unwrap();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.ends_with("conn-2"), "{response}");
        connections.recv().await.unwrap();

        let status = dispatch(
            fixture.state.clone(),
            "status",
            json!({ "connectionId": fixture.host_id }),
        )
        .await
        .unwrap();
        assert_eq!(status["state"], "connected");
        assert_eq!(status["origin"], format!("http://127.0.0.1:{}", fixture.port));
        assert_eq!(status["reconnecting"], false);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_silent_link_is_replaced_when_the_app_returns() {
        let (fixture, mut connections) =
            link_fixture(vec![FakeHostAnswer::Mute, FakeHostAnswer::Accept]).await;
        connections.recv().await.unwrap();
        let response = proxied_get(fixture.port, &fixture.cookie).await.unwrap();
        assert!(response.ends_with("conn-1"), "{response}");

        // The foreground status read probes the link; the muted host never
        // answers, so the client replaces it instead of waiting for QUIC's
        // idle timeout.
        dispatch(
            fixture.state.clone(),
            "status",
            json!({ "connectionId": fixture.host_id }),
        )
        .await
        .unwrap();
        tokio::time::timeout(LIVENESS_TIMEOUT + Duration::from_secs(10), connections.recv())
            .await
            .expect("a silent link was not replaced")
            .unwrap();
        let response = tokio::time::timeout(
            Duration::from_secs(20),
            proxied_get(fixture.port, &fixture.cookie),
        )
        .await
        .expect("request parked until the link returned")
        .unwrap();
        assert!(response.ends_with("conn-2"), "{response}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_answering_link_survives_the_foreground_probe() {
        let (fixture, mut connections) = link_fixture(vec![FakeHostAnswer::Accept]).await;
        connections.recv().await.unwrap();
        for _ in 0..3 {
            dispatch(
                fixture.state.clone(),
                "status",
                json!({ "connectionId": fixture.host_id }),
            )
            .await
            .unwrap();
        }
        let again =
            tokio::time::timeout(LIVENESS_TIMEOUT + Duration::from_secs(2), connections.recv()).await;
        assert!(again.is_err(), "a healthy link was replaced");
        let response = proxied_get(fixture.port, &fixture.cookie).await.unwrap();
        assert!(response.ends_with("conn-1"), "{response}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revocation_seen_on_reconnect_ends_the_session() {
        let (fixture, mut connections) =
            link_fixture(vec![FakeHostAnswer::Accept, FakeHostAnswer::Revoked]).await;
        let first = connections.recv().await.unwrap();
        first.close(0u32.into(), b"gone");
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let status = dispatch(
                fixture.state.clone(),
                "status",
                json!({ "connectionId": fixture.host_id }),
            )
            .await
            .unwrap();
            if status["state"] == "revoked" {
                break;
            }
            assert!(Instant::now() < deadline, "session never ended: {status}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(fixture.state.lock().await.sessions.is_empty());
        assert!(proxied_get(fixture.port, &fixture.cookie).await.is_err()
            || proxied_get(fixture.port, &fixture.cookie).await.unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn disconnect_stops_reconnecting() {
        let (fixture, mut connections) = link_fixture(vec![FakeHostAnswer::Accept]).await;
        connections.recv().await.unwrap();
        dispatch(
            fixture.state.clone(),
            "disconnect",
            json!({ "connectionId": fixture.host_id }),
        )
        .await
        .unwrap();
        // No second connection may arrive at the host after an explicit disconnect.
        let again = tokio::time::timeout(Duration::from_secs(2), connections.recv()).await;
        assert!(matches!(again, Err(_) | Ok(None)), "client reconnected after disconnect");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_dead_loopback_origin_reports_disconnected() {
        let (fixture, mut connections) = link_fixture(vec![FakeHostAnswer::Accept]).await;
        connections.recv().await.unwrap();
        fixture.state.lock().await.sessions[&fixture.host_id]
            .proxy
            .listener
            .close();
        // The native shells reconnect (new origin) on `disconnected`; a stale
        // `connected` would leave the page on a port nobody serves.
        let status = dispatch(
            fixture.state.clone(),
            "status",
            json!({ "connectionId": fixture.host_id }),
        )
        .await
        .unwrap();
        assert_eq!(status["state"], "disconnected");
    }

    /// Simulates iOS reclaiming the suspended app's listening socket: the
    /// accept loop loses its socket without ever seeing an error.
    async fn reclaim_listener(fixture: &LinkFixture) {
        let control = fixture.state.lock().await.sessions[&fixture.host_id]
            .proxy
            .control
            .clone();
        control.defunct.notify_one();
        let deadline = Instant::now() + Duration::from_secs(5);
        while TcpStream::connect(("127.0.0.1", fixture.port)).await.is_ok() {
            assert!(Instant::now() < deadline, "listener was never released");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_reclaimed_listener_is_rebound_on_its_origin_before_reporting_connected() {
        let (fixture, mut connections) = link_fixture(vec![FakeHostAnswer::Accept]).await;
        connections.recv().await.unwrap();
        reclaim_listener(&fixture).await;
        assert!(!fixture.state.lock().await.sessions[&fixture.host_id]
            .proxy
            .listener
            .is_closed());

        let status = dispatch(
            fixture.state.clone(),
            "status",
            json!({ "connectionId": fixture.host_id }),
        )
        .await
        .unwrap();
        assert_eq!(status["state"], "connected");
        assert_eq!(status["origin"], format!("http://127.0.0.1:{}", fixture.port));
        // The page's origin and cookie keep working: nothing needs a reload.
        let response = proxied_get(fixture.port, &fixture.cookie).await.unwrap();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_reclaimed_listener_whose_port_is_taken_reports_disconnected() {
        let (fixture, mut connections) = link_fixture(vec![FakeHostAnswer::Accept]).await;
        connections.recv().await.unwrap();
        reclaim_listener(&fixture).await;
        // Another local listener now owns the port. It completes TCP
        // handshakes, so a plain connect probe would call the origin alive.
        let squatter = tokio::net::TcpListener::bind(("127.0.0.1", fixture.port))
            .await
            .unwrap();

        let status = dispatch(
            fixture.state.clone(),
            "status",
            json!({ "connectionId": fixture.host_id }),
        )
        .await
        .unwrap();
        assert_eq!(status["state"], "disconnected");
        assert!(fixture.state.lock().await.sessions[&fixture.host_id]
            .proxy
            .listener
            .is_closed());
        drop(squatter);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_healthy_origin_answers_the_liveness_probe() {
        let (fixture, mut connections) = link_fixture(vec![FakeHostAnswer::Accept]).await;
        connections.recv().await.unwrap();
        let probe = fixture.state.lock().await.sessions[&fixture.host_id].proxy.probe();
        for _ in 0..3 {
            assert!(loopback_answers(&probe).await);
        }
        assert!(ensure_loopback(&probe).await);
        let response = proxied_get(fixture.port, &fixture.cookie).await.unwrap();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    }

    #[test]
    fn reconnect_backoff_is_immediate_then_bounded() {
        assert_eq!(reconnect_backoff(0), Duration::ZERO);
        assert!(reconnect_backoff(1) < reconnect_backoff(3));
        assert_eq!(reconnect_backoff(50), reconnect_backoff(RECONNECT_BACKOFF_MS.len() - 1));
        assert_eq!(
            classify_reconnect_rejection("device-revoked"),
            ReconnectFailure::Rejected { revoked: true }
        );
        assert_eq!(
            classify_reconnect_rejection("pairing-invalid"),
            ReconnectFailure::Rejected { revoked: false }
        );
    }
}
